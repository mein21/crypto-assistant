// Shared market-data helpers for Vercel functions.
// Tries Bybit (with mirrors) → OKX → Binance, so the app keeps working even
// if one host is geo-blocked from the function's edge region.
//
// Files in /api/ that start with `_` are NOT exposed as routes by Vercel.

const BYBIT_HOSTS = [
    'https://api.bybit.com',
    'https://api.bytick.com',
    'https://api.bybitglobal.com'
];
const OKX_HOSTS = [
    'https://www.okx.com',
    'https://aws.okx.com'
];
const BINANCE_HOSTS = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com'
];

const BYBIT_INTERVAL = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1w': 'W', '1M': 'M'
};
const OKX_INTERVAL = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
    '1d': '1D', '1w': '1W', '1M': '1M'
};

function toOkxInstId(symbol) {
    // BTCUSDT -> BTC-USDT
    if (symbol.endsWith('USDT')) return symbol.slice(0, -4) + '-USDT';
    if (symbol.endsWith('USDC')) return symbol.slice(0, -4) + '-USDC';
    return symbol;
}

async function fetchJSONWithFallback(urls) {
    let lastError = null;
    for (const url of urls) {
        try {
            const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!r.ok) {
                lastError = new Error(`HTTP ${r.status} ${url}`);
                continue;
            }
            return { data: await r.json(), url };
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('All hosts failed');
}

// Returns: { [symbol]: lastPrice } for the requested USDT-quoted symbols.
async function fetchPrices(symbols) {
    const wanted = new Set(symbols);

    // 1) Bybit (mirrors)
    try {
        const { data } = await fetchJSONWithFallback(
            BYBIT_HOSTS.map(h => `${h}/v5/market/tickers?category=spot`)
        );
        if (data && data.retCode === 0 && data.result && Array.isArray(data.result.list)) {
            const out = {};
            for (const t of data.result.list) {
                if (wanted.has(t.symbol)) {
                    const p = parseFloat(t.lastPrice);
                    if (Number.isFinite(p)) out[t.symbol] = p;
                }
            }
            if (Object.keys(out).length > 0) return out;
        }
    } catch (e) {
        console.warn('[marketData] Bybit tickers failed:', e.message);
    }

    // 2) OKX
    try {
        const { data } = await fetchJSONWithFallback(
            OKX_HOSTS.map(h => `${h}/api/v5/market/tickers?instType=SPOT`)
        );
        if (data && data.code === '0' && Array.isArray(data.data)) {
            const out = {};
            for (const t of data.data) {
                const sym = String(t.instId || '').replace('-', '');
                if (wanted.has(sym)) {
                    const p = parseFloat(t.last);
                    if (Number.isFinite(p)) out[sym] = p;
                }
            }
            if (Object.keys(out).length > 0) return out;
        }
    } catch (e) {
        console.warn('[marketData] OKX tickers failed:', e.message);
    }

    // 3) Binance
    try {
        const { data } = await fetchJSONWithFallback(
            BINANCE_HOSTS.map(h => `${h}/api/v3/ticker/price`)
        );
        if (Array.isArray(data)) {
            const out = {};
            for (const t of data) {
                if (wanted.has(t.symbol)) {
                    const p = parseFloat(t.price);
                    if (Number.isFinite(p)) out[t.symbol] = p;
                }
            }
            if (Object.keys(out).length > 0) return out;
        }
    } catch (e) {
        console.warn('[marketData] Binance tickers failed:', e.message);
    }

    throw new Error('Не удалось получить цены ни с одного из источников (Bybit / OKX / Binance)');
}

// Returns array of candles { time, open, high, low, close, volume } sorted oldest -> newest.
async function fetchCandles(symbol, interval, limit) {
    // 1) Bybit
    const bybitInterval = BYBIT_INTERVAL[interval];
    if (bybitInterval) {
        try {
            const { data } = await fetchJSONWithFallback(
                BYBIT_HOSTS.map(h =>
                    `${h}/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`
                )
            );
            if (data && data.retCode === 0 && data.result && Array.isArray(data.result.list)) {
                return data.result.list.slice().reverse().map(k => ({
                    time: parseInt(k[0], 10) / 1000,
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5])
                }));
            }
        } catch (e) {
            console.warn(`[marketData] Bybit kline ${symbol} failed:`, e.message);
        }
    }

    // 2) OKX
    const okxInterval = OKX_INTERVAL[interval];
    if (okxInterval) {
        try {
            const instId = toOkxInstId(symbol);
            const { data } = await fetchJSONWithFallback(
                OKX_HOSTS.map(h =>
                    `${h}/api/v5/market/candles?instId=${instId}&bar=${okxInterval}&limit=${limit}`
                )
            );
            if (data && data.code === '0' && Array.isArray(data.data)) {
                return data.data.slice().reverse().map(k => ({
                    time: parseInt(k[0], 10) / 1000,
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5])
                }));
            }
        } catch (e) {
            console.warn(`[marketData] OKX kline ${symbol} failed:`, e.message);
        }
    }

    // 3) Binance
    try {
        const { data } = await fetchJSONWithFallback(
            BINANCE_HOSTS.map(h =>
                `${h}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
            )
        );
        if (Array.isArray(data)) {
            return data.map(k => ({
                time: k[0] / 1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
    } catch (e) {
        console.warn(`[marketData] Binance kline ${symbol} failed:`, e.message);
    }

    return [];
}

module.exports = { fetchPrices, fetchCandles };
