// Shared helper for talking to a Bybit-API proxy that holds the user's keys
// and signs requests. The proxy URL can come from two places:
//   1. The X-Worker-Url request header (sent by the browser when the user has
//      a personal launcher running, e.g. proxy/launch.mjs from PR #7). This
//      takes precedence and lets the user route through their own machine.
//   2. The WORKER_URL env var on Vercel (a globally-deployed proxy).

const DEFAULT_TIMEOUT_MS = 15_000;

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

function getWorkerOverrides(req) {
    const headerUrl = req?.headers?.['x-worker-url'] || req?.headers?.['X-Worker-Url'];
    const workerUrl = sanitizeWorkerUrl(headerUrl);
    return workerUrl ? { workerUrl } : {};
}

function getWorkerConfig({ workerUrl } = {}) {
    const url = workerUrl || process.env.WORKER_URL;
    if (!url) {
        const err = new Error('WORKER_URL не настроен. Включи переключатель "Bybit" и вставь URL прокси (или задай WORKER_URL в Vercel env).');
        err.code = 'WORKER_URL_MISSING';
        throw err;
    }
    return {
        url: url.replace(/\/+$/, ''),
        // Bearer auth between Vercel and the proxy is opt-in. The default
        // launcher (proxy/launch.mjs) does not export WORKER_AUTH_TOKEN, so
        // server.js' `if (WORKER_AUTH_TOKEN)` gate is a no-op and we leave
        // the Authorization header off entirely. Power-users who set
        // WORKER_AUTH_TOKEN on both ends keep the protection.
        token: process.env.WORKER_AUTH_TOKEN || ''
    };
}

async function callBybit(endpoint, method = 'GET', params = {}, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, workerUrl } = opts;
    const { url, token } = getWorkerConfig({ workerUrl });

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

// Returns a richer USDT account summary so the UI can show live equity
// (which moves with unrealised futures PnL) instead of just walletBalance.
async function getAccountSummary(opts = {}) {
    const data = await callBybit('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }, opts);
    const acct = data.result?.list?.[0] || {};
    const coins = acct.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT') || {};
    return {
        wallet: parseFloat(usdt.walletBalance) || 0,
        equity: parseFloat(usdt.equity) || 0,
        available: parseFloat(usdt.availableToWithdraw) || 0,
        unrealisedPnl: parseFloat(usdt.unrealisedPnl) || 0,
        totalEquity: parseFloat(acct.totalEquity) || 0,
        totalAvailableBalance: parseFloat(acct.totalAvailableBalance) || 0,
        totalWalletBalance: parseFloat(acct.totalWalletBalance) || 0
    };
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

// Fetches all open USDT-perpetual (linear) positions for the account.
// Returns a normalised array — only entries with non-zero size are kept,
// and the Bybit Buy/Sell side is mapped to LONG/SHORT for downstream use.
async function getFuturesPositions(opts = {}) {
    const data = await callBybit(
        '/v5/position/list',
        'GET',
        { category: 'linear', settleCoin: 'USDT' },
        opts
    );
    const list = data.result?.list || [];
    return list
        .filter(p => parseFloat(p.size) > 0)
        .map(p => {
            const tp = parseFloat(p.takeProfit);
            const sl = parseFloat(p.stopLoss);
            const liq = parseFloat(p.liqPrice);
            return {
                symbol: p.symbol,
                side: p.side === 'Sell' ? 'SHORT' : 'LONG',
                size: parseFloat(p.size) || 0,
                avgPrice: parseFloat(p.avgPrice) || 0,
                markPrice: parseFloat(p.markPrice) || 0,
                positionValue: parseFloat(p.positionValue) || 0,
                unrealisedPnl: parseFloat(p.unrealisedPnl) || 0,
                leverage: parseFloat(p.leverage) || 0,
                takeProfit: Number.isFinite(tp) && tp > 0 ? tp : null,
                stopLoss: Number.isFinite(sl) && sl > 0 ? sl : null,
                liqPrice: Number.isFinite(liq) && liq > 0 ? liq : null
            };
        });
}

async function getOrderHistory(category = 'linear', limit = 100, opts = {}) {
    const data = await callBybit('/v5/order/history', 'GET', { category, limit }, opts);
    return data.result?.list || [];
}

async function cancelOrder(orderId, symbol, category = 'linear', opts = {}) {
    return callBybit('/v5/order/cancel', 'POST', { category, symbol, orderId }, opts);
}

// Per-symbol tick decimals for price/TP/SL rounding. Bybit rejects orders with
// more decimal places than the contract supports.
const PRICE_DECIMALS = {
    BTCUSDT: 2, ETHUSDT: 2, SOLUSDT: 3, BNBUSDT: 2,
    ADAUSDT: 4, DOGEUSDT: 5, DOTUSDT: 3, AVAXUSDT: 2,
    LTCUSDT: 2, LINKUSDT: 3, MATICUSDT: 4
};

function roundOrderPrice(symbol, price) {
    if (price === null || price === undefined || price === '') return null;
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = PRICE_DECIMALS[symbol] ?? 2;
    return parseFloat(n.toFixed(d));
}

// Instrument-info cache. Bybit's /v5/market/instruments-info returns
// qtyStep/minOrderQty/minOrderAmt for each symbol, which we need to round
// quantities correctly and reject orders the exchange would reject anyway
// with a confusing 10001 ("contracts exceeds minimum"). Cache for 1h —
// these fields almost never change, but we don't want a stale cache forever
// in case Bybit relists a contract with new tick rules.
const INSTRUMENT_TTL_MS = 60 * 60 * 1000;
const instrumentCache = new Map(); // symbol -> { info, expires }

function decimalsFromStep(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    if (step >= 1) return 0;
    // 0.001 -> "0.001" -> 3
    const s = step.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : (s.length - dot - 1);
}

async function getInstrumentInfo(symbol, opts = {}) {
    const now = Date.now();
    const cached = instrumentCache.get(symbol);
    if (cached && cached.expires > now) return cached.info;

    const data = await callBybit(
        '/v5/market/instruments-info',
        'GET',
        { category: 'linear', symbol },
        opts
    );
    const item = data.result?.list?.[0];
    if (!item) {
        const err = new Error(`Bybit не знает символ ${symbol}`);
        err.code = 'INSTRUMENT_UNKNOWN';
        throw err;
    }
    const lot = item.lotSizeFilter || {};
    const priceF = item.priceFilter || {};
    const qtyStep = parseFloat(lot.qtyStep) || 0;
    const minOrderQty = parseFloat(lot.minOrderQty) || 0;
    // `minNotionalValue` is Bybit V5's min order amount in quote (USDT). Some
    // symbols only have it on the lot filter as `minOrderAmt`. Fall back
    // to a hardcoded $5 (Bybit's default for most USDT-perp pairs) so we
    // never hand the user "no minimum" and silently let the exchange reject.
    const minOrderAmt = parseFloat(lot.minNotionalValue ?? lot.minOrderAmt) || 5;
    const tickSize = parseFloat(priceF.tickSize) || 0;
    const info = {
        symbol,
        qtyStep,
        qtyDecimals: decimalsFromStep(qtyStep),
        minOrderQty,
        minOrderAmt,
        tickSize,
        priceDecimals: decimalsFromStep(tickSize)
    };
    instrumentCache.set(symbol, { info, expires: now + INSTRUMENT_TTL_MS });
    return info;
}

function roundQtyDown(qty, step) {
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) return qty;
    // Use a scaled integer division to dodge fp drift like 0.1+0.2 != 0.3.
    const scale = Math.pow(10, decimalsFromStep(step));
    const stepInt = Math.round(step * scale);
    const qtyInt  = Math.floor(qty * scale);
    const rounded = (qtyInt - (qtyInt % stepInt)) / scale;
    return parseFloat(rounded.toFixed(decimalsFromStep(step)));
}

async function placeFuturesOrder(symbol, side, qty, price = null, tp = null, sl = null, opts = {}) {
    // Snap qty to the symbol's lotSizeFilter rules and reject upfront if the
    // request would never make it past Bybit's contract filters. Catches
    // 10001 ("contracts exceeds minimum") and "qty has too many decimals"
    // before we waste a round-trip and a retCode toast on the user.
    let info;
    try { info = await getInstrumentInfo(symbol, opts); }
    catch (_) { info = null; /* fall back to no-op rounding */ }

    let finalQty = Number(qty);
    if (info && info.qtyStep > 0) {
        finalQty = roundQtyDown(finalQty, info.qtyStep);
        if (finalQty < info.minOrderQty) {
            const refPrice = price ? Number(price) : null;
            const minNotional = refPrice && refPrice > 0
                ? Math.max(info.minOrderQty * refPrice, info.minOrderAmt)
                : info.minOrderAmt;
            const err = new Error(
                `Минимум для ${symbol} — ${info.minOrderQty} (≈$${minNotional.toFixed(2)}). ` +
                `Запрошенное qty ${qty} меньше шага лота.`
            );
            err.code = 'QTY_BELOW_MIN';
            err.payload = { qty, minOrderQty: info.minOrderQty, qtyStep: info.qtyStep };
            throw err;
        }
        if (price) {
            const notional = finalQty * Number(price);
            if (notional < info.minOrderAmt) {
                const err = new Error(
                    `Сумма ордера $${notional.toFixed(2)} меньше минимума ${symbol} ($${info.minOrderAmt}).`
                );
                err.code = 'NOTIONAL_BELOW_MIN';
                err.payload = { notional, minOrderAmt: info.minOrderAmt };
                throw err;
            }
        }
    }

    const roundedPrice = roundOrderPrice(symbol, price);
    const roundedTp = roundOrderPrice(symbol, tp);
    const roundedSl = roundOrderPrice(symbol, sl);

    const params = {
        category: 'linear',
        symbol,
        side,
        orderType: roundedPrice ? 'Limit' : 'Market',
        qty: String(finalQty),
        timeInForce: 'GTC'
    };
    if (roundedPrice) params.price = String(roundedPrice);
    if (roundedTp || roundedSl) {
        // Without these explicit fields Bybit V5 sometimes silently drops the
        // attached TP/SL on market orders, depending on the account's tpsl
        // mode. Setting them explicitly makes the behaviour deterministic.
        params.tpslMode = 'Full';
        if (roundedTp) {
            params.takeProfit = String(roundedTp);
            params.tpTriggerBy = 'LastPrice';
            params.tpOrderType = 'Market';
        }
        if (roundedSl) {
            params.stopLoss = String(roundedSl);
            params.slTriggerBy = 'LastPrice';
            params.slOrderType = 'Market';
        }
    }
    return callBybit('/v5/order/create', 'POST', params, opts);
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Worker-Url');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Live account data — never let the browser, Vercel edge, or any
    // intermediary cache a stale balance/positions/orders payload.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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
    getAccountSummary,
    getAllCoins,
    getOpenOrders,
    getOrderHistory,
    getFuturesPositions,
    cancelOrder,
    placeFuturesOrder,
    getInstrumentInfo,
    roundQtyDown,
    getWorkerOverrides,
    setCors,
    errorPayload
};
