// Vercel Serverless Function: GET /api/pending
// Returns Bybit open orders (linear futures by default).

const { getOpenOrders, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const category = (req.query && req.query.category) || 'linear';
        const opts = getWorkerOverrides(req);
        const orders = await getOpenOrders(category, opts);
        return res.status(200).json({ success: true, orders });
    } catch (e) {
        console.error('pending error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
