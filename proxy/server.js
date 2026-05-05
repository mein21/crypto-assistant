// Fly.io Bybit-API proxy.
// Same logic as ../worker.js, but runs as Node/Express on a fly machine.
// We deploy it to a region that Bybit doesn't geo-block (Singapore by default),
// because Cloudflare Workers' outbound IPs hit Bybit's CloudFront 403 wall.
//
// Required env vars:
//   BYBIT_API_KEY, BYBIT_API_SECRET   - signed Bybit credentials
//   WORKER_AUTH_TOKEN                 - shared bearer secret with the Vercel side
// Optional:
//   TESTNET = "true" | "false"        - default false
//   PORT                              - default 8080 (Fly sets this)

const express = require('express');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TESTNET = process.env.TESTNET === 'true';
const BYBIT_API_KEY = process.env.BYBIT_API_KEY;
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET;
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN;

const BYBIT_HOSTS = TESTNET
    ? ['https://api-testnet.bybit.com']
    : ['https://api.bybit.com', 'https://api.bytick.com', 'https://api.bybitglobal.com'];

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.get('/health', (_req, res) => res.json({ ok: true, region: process.env.FLY_REGION || 'unknown' }));

app.post('/bybit', async (req, res) => {
    if (WORKER_AUTH_TOKEN) {
        const auth = req.get('Authorization') || '';
        const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (presented !== WORKER_AUTH_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized: invalid or missing Bearer token' });
        }
    }

    if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
        return res.status(500).json({
            error: 'BYBIT_API_KEY / BYBIT_API_SECRET не установлены в Fly secrets. Используй `fly secrets set ...`.'
        });
    }

    const { endpoint, method = 'GET', params = {} } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
        return res.status(400).json({ error: 'Missing required field: endpoint' });
    }

    const timestamp = Date.now().toString();
    const recvWindow = '5000';

    let paramStr = '';
    let bodyStr = '';
    if (method === 'GET') {
        const sortedKeys = Object.keys(params).sort();
        paramStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    } else {
        bodyStr = JSON.stringify(params);
    }

    const signaturePayload = timestamp + BYBIT_API_KEY + recvWindow + (method === 'GET' ? paramStr : bodyStr);
    const signature = crypto.createHmac('sha256', BYBIT_API_SECRET).update(signaturePayload).digest('hex');
    const queryString = paramStr ? '?' + paramStr : '';

    const headers = {
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json'
    };

    let lastStatus = 502;
    let lastBody = '';
    for (const baseUrl of BYBIT_HOSTS) {
        try {
            const r = await fetch(baseUrl + endpoint + queryString, {
                method,
                headers,
                body: method === 'GET' ? undefined : bodyStr
            });
            const text = await r.text();
            if (r.status >= 500 || (r.status === 403 && /CloudFront|country/i.test(text))) {
                lastStatus = r.status;
                lastBody = text;
                continue;
            }
            res.status(r.status).type('application/json').send(text);
            return;
        } catch (e) {
            lastStatus = 502;
            lastBody = e.message || String(e);
        }
    }
    res.status(lastStatus).type('application/json').send(lastBody || '{"error":"All Bybit hosts failed"}');
});

app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}. Use POST /bybit or GET /health.` });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bybit proxy listening on 0.0.0.0:${PORT} (testnet=${TESTNET}, hosts=${BYBIT_HOSTS.join(',')})`);
});
