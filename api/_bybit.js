// Shared helper for talking to a Bybit-API proxy that holds the user's keys
// and signs requests. The proxy URL can come from two places:
//   1. The X-Worker-Url request header (sent by the browser when the user has
//      a personal launcher running, e.g. proxy/launch.mjs from PR #7). This
//      takes precedence and lets the user route through their own machine.
//   2. The WORKER_URL env var on Vercel (a globally-deployed proxy).

const DEFAULT_TIMEOUT_MS = 15_000;

// Same default that proxy/launch.mjs writes to the user's local proxy/.env
// when they install the launcher. Keeping the two sides in sync means the
// proxy's `Bearer` check works out of the box without the user having to
// manage a `WORKER_AUTH_TOKEN` env var on Vercel themselves. Power-users
// can still override it (a) by setting WORKER_AUTH_TOKEN on Vercel, or
// (b) by sending an X-Worker-Token request header from the browser.
const DEFAULT_WORKER_AUTH_TOKEN =
    '2dca78d44cf3e74559d5ac4c0aa4b8e90e5f4aa0d900a2ad0f16a23a78f4ef74';

function sanitizeWorkerUrl(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    let parsed;
    try { parsed = new URL(trimmed); } catch (_) { return null; }
    if (parsed.protocol !== 'https:') return null;
    // Reject literal IPs and localhost to limit SSRF surface to public hostnames.
    const host = parsed.hostname;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
    if (host === 'localhost' || host.endsWith('.localhost')) return null;
    return parsed.origin;
}

function sanitizeWorkerToken(raw) {
    if (typeof raw !== 'string') return '';
    // Tokens must be ASCII-safe to ride in an HTTP header. Reject anything
    // suspicious so we don't crash node's fetch with invalid header chars.
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 256) return '';
    if (!/^[A-Za-z0-9._\-]+$/.test(trimmed)) return '';
    return trimmed;
}

function getWorkerOverrides(req) {
    const headerUrl = req?.headers?.['x-worker-url'] || req?.headers?.['X-Worker-Url'];
    const workerUrl = sanitizeWorkerUrl(headerUrl);
    const headerToken = req?.headers?.['x-worker-token'] || req?.headers?.['X-Worker-Token'];
    const workerToken = sanitizeWorkerToken(headerToken);
    const out = {};
    if (workerUrl) out.workerUrl = workerUrl;
    if (workerToken) out.workerToken = workerToken;
    return out;
}

function getWorkerConfig({ workerUrl, workerToken } = {}) {
    const url = workerUrl || process.env.WORKER_URL;
    if (!url) {
        const err = new Error('WORKER_URL не настроен. Включи переключатель "Bybit" и вставь URL прокси (или задай WORKER_URL в Vercel env).');
        err.code = 'WORKER_URL_MISSING';
        throw err;
    }
    return {
        url: url.replace(/\/+$/, ''),
        // Precedence: per-request browser override > Vercel env > shared default.
        token: workerToken || process.env.WORKER_AUTH_TOKEN || DEFAULT_WORKER_AUTH_TOKEN
    };
}

async function callBybit(endpoint, method = 'GET', params = {}, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, workerUrl, workerToken } = opts;
    const { url, token } = getWorkerConfig({ workerUrl, workerToken });

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

async function getUSDTBalance(opts = {}) {
    const data = await callBybit('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }, opts);
    const coins = data.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT');
    return usdt ? parseFloat(usdt.walletBalance) : 0;
}

async function getAllCoins(opts = {}) {
    const data = await callBybit('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }, opts);
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

async function getOpenOrders(category = 'linear', opts = {}) {
    const data = await callBybit('/v5/order/realtime', 'GET', { category, openOnly: 1 }, opts);
    return data.result?.list || [];
}

async function getOrderHistory(category = 'linear', limit = 100, opts = {}) {
    const data = await callBybit('/v5/order/history', 'GET', { category, limit }, opts);
    return data.result?.list || [];
}

async function cancelOrder(orderId, symbol, category = 'linear', opts = {}) {
    return callBybit('/v5/order/cancel', 'POST', { category, symbol, orderId }, opts);
}

async function placeFuturesOrder(symbol, side, qty, price = null, tp = null, sl = null, opts = {}) {
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
    return callBybit('/v5/order/create', 'POST', params, opts);
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Worker-Url, X-Worker-Token');
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
    getWorkerOverrides,
    setCors,
    errorPayload
};
