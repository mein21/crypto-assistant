// Vercel Serverless Function: POST /api/execute-market
// Places a Bybit linear futures MARKET order via the Cloudflare Worker proxy.
// Body: { symbol, side, qty, tp?, sl? }
// side: "Buy" = LONG, "Sell" = SHORT.
// tp/sl are forwarded as attached take-profit/stop-loss on the position.

const { placeFuturesOrder, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

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
        const result = await placeFuturesOrder(symbol, side, qty, null, tp, sl, opts);
        return res.status(200).json({ success: true, result });
    } catch (e) {
        console.error('execute-market error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
