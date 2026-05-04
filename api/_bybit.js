// Shared helper for talking to the Cloudflare Worker that proxies Bybit's
// private API. The worker holds the Bybit credentials and signs requests; the
// Vercel serverless functions only need the worker URL plus a shared token.

const DEFAULT_TIMEOUT_MS = 15_000;

function getWorkerConfig() {
    const url = process.env.WORKER_URL;
    if (!url) {
        const err = new Error('WORKER_URL не настроен в Vercel. Добавь переменную в Settings → Environment Variables и задеплой Cloudflare Worker (см. DEPLOY_WORKER.md).');
        err.code = 'WORKER_URL_MISSING';
        throw err;
    }
    return {
        url: url.replace(/\/+$/, ''),
        token: process.env.WORKER_AUTH_TOKEN || ''
    };
}

async function callBybit(endpoint, method = 'GET', params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const { url, token } = getWorkerConfig();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const resp = await fetch(`${url}/bybit`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ endpoint, method, params }),
            signal: controller.signal
        });

        const text = await resp.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (_) {
            const err = new Error(`Worker вернул невалидный JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
            err.code = 'WORKER_BAD_JSON';
            throw err;
        }

        if (!resp.ok) {
            const err = new Error(data.error || `Worker HTTP ${resp.status}`);
            err.code = 'WORKER_HTTP_ERROR';
            err.status = resp.status;
            err.payload = data;
            throw err;
        }

        if (data.retCode !== 0 && data.retCode !== undefined) {
            const err = new Error(`Bybit ${data.retCode}: ${data.retMsg || 'unknown'}`);
            err.code = 'BYBIT_API_ERROR';
            err.payload = data;
            throw err;
        }

        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            const err = new Error(`Worker не ответил за ${timeoutMs} мс`);
            err.code = 'WORKER_TIMEOUT';
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

async function getUSDTBalance() {
    const data = await callBybit('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
    const coins = data.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT');
    return usdt ? parseFloat(usdt.walletBalance) : 0;
}

async function getAllCoins() {
    const data = await callBybit('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
    const coins = data.result?.list?.[0]?.coin || [];
    const out = {};
    for (const c of coins) {
        const available = parseFloat(c.availableToWithdraw) || 0;
        const wallet = parseFloat(c.walletBalance) || 0;
        const equity = parseFloat(c.equity) || 0;
        const qty = available > 0 ? available : (wallet > 0 ? wallet : equity);
        if (qty > 0) out[c.coin] = qty;
    }
    return out;
}

async function getOpenOrders(category = 'linear') {
    const data = await callBybit('/v5/order/realtime', 'GET', { category, openOnly: 1 });
    return data.result?.list || [];
}

async function getOrderHistory(category = 'linear', limit = 100) {
    const data = await callBybit('/v5/order/history', 'GET', { category, limit });
    return data.result?.list || [];
}

async function cancelOrder(orderId, symbol, category = 'linear') {
    return callBybit('/v5/order/cancel', 'POST', { category, symbol, orderId });
}

async function placeFuturesOrder(symbol, side, qty, price = null, tp = null, sl = null) {
    const params = {
        category: 'linear',
        symbol,
        side,
        orderType: price ? 'Limit' : 'Market',
        qty: String(qty),
        timeInForce: 'GTC'
    };
    if (price) params.price = String(price);
    if (tp) params.takeProfit = String(tp);
    if (sl) params.stopLoss = String(sl);
    return callBybit('/v5/order/create', 'POST', params);
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function errorPayload(e) {
    return {
        success: false,
        error: e.message || String(e),
        code: e.code || 'UNKNOWN'
    };
}

module.exports = {
    callBybit,
    getUSDTBalance,
    getAllCoins,
    getOpenOrders,
    getOrderHistory,
    cancelOrder,
    placeFuturesOrder,
    setCors,
    errorPayload
};
