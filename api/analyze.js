// Test version - minimal
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    res.json({
        success: true,
        message: 'API is working',
        prices: { 'BTCUSDT': 67500 },
        trade: {
            pair: 'BTCUSDT',
            direction: 'LONG',
            entryPrice: 67500,
            tp: 69000,
            sl: 66500,
            confidence: 8,
            reason: 'Test'
        }
    });
};
