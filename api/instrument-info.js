// Vercel Serverless Function: GET /api/instrument-info?symbol=BTCUSDT
// Returns lotSizeFilter / priceFilter values from Bybit V5 instruments-info,
// in the shape the frontend uses for client-side qty rounding and pre-flight
// "below min order" gating before /api/execute.

const { getInstrumentInfo, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }
    const symbol = (req.query?.symbol || '').toString().toUpperCase().replace('/', '');
    if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol required' });
    }
    try {
        const opts = getWorkerOverrides(req);
        const info = await getInstrumentInfo(symbol, opts);
        return res.status(200).json({ success: true, ...info });
    } catch (e) {
        console.error('instrument-info error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
