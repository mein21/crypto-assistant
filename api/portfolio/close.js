// Vercel Serverless Function: POST /api/portfolio/close
// Cancels every open Bybit linear order via the Cloudflare Worker proxy.

const { getOpenOrders, cancelOrder, setCors, errorPayload } = require('../_bybit');

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const list = await getOpenOrders('linear');
        const results = [];
        for (const order of list) {
            try {
                await cancelOrder(order.orderId, order.symbol, 'linear');
                results.push({ symbol: order.symbol, orderId: order.orderId, status: 'cancelled' });
            } catch (e) {
                results.push({ symbol: order.symbol, orderId: order.orderId, error: e.message });
            }
        }
        return res.status(200).json({ success: true, results });
    } catch (e) {
        console.error('portfolio/close error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
