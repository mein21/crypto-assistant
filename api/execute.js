// Vercel Serverless Function: POST /api/execute
// Places a Bybit linear futures LIMIT order via the Cloudflare Worker proxy.
// Body: { symbol, side, qty, price?, tp?, sl? }
// side is the direction the user picked on the frontend ("Buy" = LONG, "Sell" = SHORT).

const { placeFuturesOrder, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

const DECIMALS = {
    BTCUSDT: 2, ETHUSDT: 2, SOLUSDT: 3, BNBUSDT: 2,
    ADAUSDT: 4, DOGEUSDT: 5, DOTUSDT: 3, AVAXUSDT: 2,
    LTCUSDT: 2, LINKUSDT: 3, MATICUSDT: 4
};

function roundPrice(symbol, price) {
    if (price === null || price === undefined || price === '') return null;
    const n = Number(price);
    if (!Number.isFinite(n)) return null;
    const d = DECIMALS[symbol] ?? 2;
    return parseFloat(n.toFixed(d));
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body.length > 0) {
        try { return JSON.parse(req.body); } catch (_) { return {}; }
    }
    return await new Promise((resolve) => {
        let chunks = '';
        req.on('data', (c) => { chunks += c; });
        req.on('end', () => {
            try { resolve(chunks ? JSON.parse(chunks) : {}); }
            catch (_) { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const body = await readJsonBody(req);
        const { symbol, side, qty } = body;
        const price = body.price ?? null;
        const tp = body.tp ?? null;
        const sl = body.sl ?? null;

        if (!symbol || !side || !qty) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: symbol, side, qty',
                received: { symbol, side, qty }
            });
        }
        if (Number(qty) <= 0) {
            return res.status(400).json({ success: false, error: `Неверное количество: ${qty}` });
        }

        const opts = getWorkerOverrides(req);
        const result = await placeFuturesOrder(
            symbol,
            side,
            qty,
            roundPrice(symbol, price),
            roundPrice(symbol, tp),
            roundPrice(symbol, sl),
            opts
        );
        return res.status(200).json({ success: true, result });
    } catch (e) {
        console.error('execute error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
