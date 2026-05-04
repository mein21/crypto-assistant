// Vercel Serverless Function: GET /api/balance
// Returns the live USDT balance from Bybit, fetched via the Cloudflare Worker
// proxy. No fallbacks, no API keys in the browser.

const { getUSDTBalance, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const opts = getWorkerOverrides(req);
        const balance = await getUSDTBalance(opts);
        return res.status(200).json({ success: true, balance });
    } catch (e) {
        console.error('balance error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
