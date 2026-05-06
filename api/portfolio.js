// Vercel Serverless Function: POST /api/portfolio
// Asks the AI to pick the 5 best trades across the supported symbols using
// the same multi-indicator bundle as /api/analyze (RSI + MACD + EMA +
// Bollinger + Stoch + ATR + 8-candle history). Returns ONLY what the AI
// produced. No hard-coded fallback values.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');
const { fetchLatestNews, formatNewsBlock, formatUpcomingHints } = require('./_news');
const { enforceMinRR } = require('./_rrGuard');
const { detectPriceShock, formatShockTag, enforceNoShockTrade } = require('./_priceShock');

// Default symbol set when the client doesn't pass one. Must be a subset of
// the backend's supported pairs (see PRICE_DECIMALS in api/_bybit.js).
// Pairs priced in 4+ decimals (ADA/DOGE/MATIC) are intentionally dropped:
// their tick size is small enough that the free model frequently produces
// TP/SL pairs whose RR rounds to ~0 — guaranteed loss after fees.
const DEFAULT_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT'
];
const SUPPORTED_SYMBOLS = new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT'
]);
// NVIDIA Nemotron 3 Super: Finance #26, Programming #8 on OpenRouter.
// 120B-param MoE (12B active), stable free tier, 262K context.
const OPENROUTER_MODEL =
    process.env.OPENROUTER_PORTFOLIO_MODEL ||
    process.env.OPENROUTER_MODEL ||
    'nvidia/nemotron-3-super-120b-a12b:free';
// Hard ceiling on the OpenRouter call. Anything slower returns a clean
// error to the client instead of hanging until Vercel kills the function.
// Sized just under Vercel's 90s maxDuration to leave room for response
// parsing + JSON encoding + indicator/news prep done before the call.
const OPENROUTER_TIMEOUT_MS = 80_000;

// Read POST body — Vercel/Node populates `req.body` for JSON requests, but
// some adapters (Cloudflare Pages, custom Express) leave it as a stream, so
// we fall back to manual parsing when needed.
async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return {}; }
    }
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

// Validate a list of user-supplied symbols against the supported allowlist.
// Returns a deduped array of valid uppercase symbols (or the default set if
// nothing valid was provided).
function pickSymbols(input) {
    if (!Array.isArray(input)) return DEFAULT_SYMBOLS.slice();
    const seen = new Set();
    const out = [];
    for (const raw of input) {
        if (typeof raw !== 'string') continue;
        const sym = raw.trim().toUpperCase();
        if (!SUPPORTED_SYMBOLS.has(sym)) continue;
        if (seen.has(sym)) continue;
        seen.add(sym);
        out.push(sym);
    }
    return out.length ? out : DEFAULT_SYMBOLS.slice();
}

async function computeIndicators(prices) {
    const symbols = Object.keys(prices);
    const results = await Promise.all(symbols.map(async (symbol) => {
        try {
            const [candles1h, candles4h] = await Promise.all([
                fetchCandles(symbol, '1h', 100),
                fetchCandles(symbol, '4h', 100)
            ]);
            if (!candles1h.length) return null;
            const bundle1h = buildIndicatorBundle(candles1h);
            if (!bundle1h) return null;
            const bundle4h = candles4h.length ? buildIndicatorBundle(candles4h) : null;
            return [symbol, { h1: bundle1h, h4: bundle4h }];
        } catch (e) {
            console.error(`indicator ${symbol}:`, e.message);
            return null;
        }
    }));
    return Object.fromEntries(results.filter(Boolean));
}

function computeShocks(indicators) {
    const out = {};
    for (const [symbol, ind] of Object.entries(indicators)) {
        const shock = detectPriceShock(ind.h1);
        if (shock) out[symbol] = shock;
    }
    return out;
}

function formatHTFLine(symbol, bundle4h, price) {
    if (!bundle4h) return `  4h: нет данных`;
    const parts = [];
    parts.push(`тренд=${bundle4h.trend || 'neutral'}`);
    if (Number.isFinite(bundle4h.rsi)) parts.push(`RSI=${bundle4h.rsi.toFixed(1)}`);
    if (bundle4h.macd) parts.push(`MACD гист. ${bundle4h.macd.histogram >= 0 ? 'бычья' : 'медвежья'}`);
    if (Number.isFinite(bundle4h.ema20) && Number.isFinite(bundle4h.ema50)) {
        parts.push(bundle4h.ema20 > bundle4h.ema50 ? 'EMA20>50' : 'EMA20<50');
    }
    if (bundle4h.signalScore) {
        const s = bundle4h.signalScore.score;
        parts.push(`БАЛЛ=${s > 0 ? '+' : ''}${s}`);
    }
    return `  4h: ${parts.join(', ')}`;
}

function buildPrompt(prices, indicators, shocks, news) {
    const priceLines = Object.entries(prices)
        .map(([s, p]) => `- ${s}: $${p}`)
        .join('\n');

    const indLines = Object.entries(indicators)
        .map(([s, ind]) => {
            const base = formatIndicatorLine(s, ind.h1, prices[s]);
            const htf = formatHTFLine(s, ind.h4, prices[s]);
            const tag = shocks[s] ? `\n  · ${formatShockTag(shocks[s])}` : '';
            return base + tag + '\n' + htf;
        })
        .join('\n');

    const newsBlock = formatNewsBlock(news, Object.keys(prices));
    const newsSection = newsBlock
        ? `\nНовости (★ — пара из набора):\n${newsBlock}\n`
        : '';

    const upcoming = formatUpcomingHints();

    return `Ты профессиональный инвестор-аналитик. Твоя цель — ПРИБЫЛЬНЫЕ сделки, а не количество. Лучше поставить HET (не торговать), чем войти в убыточную сделку.

Цены:
${priceLines}

Индикаторы 1h (основной ТФ) + 4h (старший ТФ для подтверждения тренда):
Баллы уже посчитаны кодом: положительный = LONG сигнал, отрицательный = SHORT, 0 = нейтральный.
${indLines}
${newsSection}
Календарь: ${upcoming}

ПРАВИЛА ПРОФЕССИОНАЛЬНОГО ТРЕЙДЕРА:

ПРАВИЛО 1 — ТОРГУЙ ТОЛЬКО ПО ТРЕНДУ СТАРШЕГО ТФ:
- 4h тренд bullish или 4h БАЛЛ > 0 → разрешены ТОЛЬКО LONG
- 4h тренд bearish или 4h БАЛЛ < 0 → разрешены ТОЛЬКО SHORT
- 4h нейтральный И 4h БАЛЛ = 0 → HET для этой пары

ПРАВИЛО 2 — МИНИМУМ ПОДТВЕРЖДЕНИЙ:
- 1h БАЛЛ должен совпадать по знаку с 4h
- |1h БАЛЛ| ≥ 3 — иначе HET
- ДИВЕРГЕНЦИЯ → -2 к доверию. Объём слабый → -1

ПРАВИЛО 3 — EMA200 ФИЛЬТР:
- Цена выше EMA200 → только LONG. SHORT при цене выше EMA200 → HET
- Цена ниже EMA200 → только SHORT. LONG при цене ниже EMA200 → HET

ПРАВИЛО 4 — TP/SL ПО СТРУКТУРЕ:
- SL: за ближайшим S/R уровнем + 0.3×ATR запас
- TP: до ближайшего S/R в направлении сделки ИЛИ 2-3×ATR
- SL не ближе 0.8×ATR от entry (зона шума)

ПРАВИЛО 5 — CONFIDENCE строго:
|1h БАЛЛ|=3→5, =4→6, =5→7, =6→8, ≥7→9
+1 за сильный 4h, -1 дивергенция, -1 слабый объём, ±1 новости.

ПРАВИЛО 6 — ШОК = HET. Без исключений.

ПРАВИЛО 7 — RR:
Минимум RR ≥ 1.5 (conf≥8 → ≥0.5, conf≥6 → ≥1.0). RR ≤ 0 — НИКОГДА.
TP минимум на 0.2% от entry.

ПРАВИЛО 8 — СОРТИРОВКА:
Сортируй пары по |1h БАЛЛ| убыванию, затем по ATR% (выше = лучше). Бери топ-5.
Если пара не проходит правила 1-3 — ставь HET для неё, но включай в список.

REASON — русский. Формат: «1h=N, 4h=N; [сигналы]; RR≈X.X».

JSON-массив из 5 (ТОЛЬКО JSON):
[{"pair":"BTCUSDT","direction":"LONG|SHORT|HET","entryPrice":N,"tp":N,"sl":N,"confidence":1-10,"reason":"кратко"}]

LONG: TP>entry, SL<entry. SHORT: TP<entry, SL>entry. HET: entry/tp/sl можно null.`;
}

async function callOpenRouter(prompt, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    let r;
    try {
        r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                // 5 trades with concise reasons ≈ 1200-1400 tokens; 1500 is
                // a safe ceiling. Was 2500, which let the free-tier model
                // stretch the response and blow Vercel's 60s timeout.
                max_tokens: 1500,
                // temperature 0 + seed for deterministic output: clicking
                // "5 пар" twice with the same data should return the same
                // set, not a random reshuffle.
                temperature: 0,
                top_p: 1,
                seed: 42,
                messages: [{ role: 'user', content: prompt }]
            })
        });
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
            throw new Error(`OpenRouter не ответил за ${OPENROUTER_TIMEOUT_MS / 1000}с (модель ${OPENROUTER_MODEL}). Попробуй ещё раз.`);
        }
        throw e;
    }
    clearTimeout(timer);

    const text = await r.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`OpenRouter non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}`);
    }
    if (!r.ok) {
        const msg = (data && data.error && data.error.message) ? data.error.message : text;
        throw new Error(`OpenRouter HTTP ${r.status}: ${msg}`);
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    if (!content) throw new Error('OpenRouter returned empty content');
    return content;
}

function parseAIPairs(content) {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
        const arr = JSON.parse(match[0]);
        return Array.isArray(arr) ? arr : null;
    } catch {
        return null;
    }
}

function toNumberOrNull(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

// Some models return confidence on a 0-100 scale despite the prompt asking
// for 0-10. Squash anything > 10 down to /10 so the UI is consistent.
function normaliseConfidence(v) {
    const n = toNumberOrNull(v);
    if (n == null) return null;
    if (n > 10) return Math.round(n / 10);
    return n;
}

function normalisePair(p) {
    return {
        pair: p.pair ? String(p.pair).replace('/', '') : '',
        direction: p.direction ? String(p.direction).toUpperCase() : '',
        entryPrice: toNumberOrNull(p.entryPrice),
        tp: toNumberOrNull(p.tp),
        sl: toNumberOrNull(p.sl),
        confidence: normaliseConfidence(p.confidence),
        reason: p.reason ? String(p.reason) : ''
    };
}

// Hard guard: demote trades that go against the 4h timeframe trend.
function enforce4hTrendAlignment(trade, indicators) {
    if (!trade) return trade;
    const dir = String(trade.direction || '').toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT') return trade;

    const ind = indicators[trade.pair];
    if (!ind || !ind.h4) return trade;

    const h4 = ind.h4;
    const h4Score = h4.signalScore ? h4.signalScore.score : 0;
    const h4Trend = h4.trend || 'neutral';

    const h4Bullish = h4Trend === 'bullish' || h4Score > 0;
    const h4Bearish = h4Trend === 'bearish' || h4Score < 0;

    let demote = false;
    if (dir === 'LONG' && h4Bearish) demote = true;
    if (dir === 'SHORT' && h4Bullish) demote = true;
    if (!h4Bullish && !h4Bearish) demote = true;

    if (h4.ema200 != null && h4.lastClose != null) {
        if (dir === 'LONG' && h4.lastClose < h4.ema200) demote = true;
        if (dir === 'SHORT' && h4.lastClose > h4.ema200) demote = true;
    }

    if (!demote) return trade;

    const note = `[4h тренд=${h4Trend}, 4h балл=${h4Score} — против старшего ТФ]`;
    const reason = trade.reason ? `${trade.reason} ${note}` : note;
    return {
        ...trade,
        direction: 'HET',
        entryPrice: null,
        tp: null,
        sl: null,
        reason
    };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            success: false,
            error: 'OPENROUTER_API_KEY не настроен в переменных окружения Vercel. Добавь его в Settings → Environment Variables и сделай Redeploy.'
        });
    }

    const t0 = Date.now();
    try {
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const symbols = pickSymbols(body && body.symbols);
        console.log(`[portfolio] fetching prices for ${symbols.length} symbols: ${symbols.join(',')}`);
        const prices = await fetchPrices(symbols);
        console.log(`[portfolio] prices: ${Object.keys(prices).length} symbols in ${Date.now() - t0}ms`);
        if (Object.keys(prices).length === 0) {
            return res.status(502).json({ success: false, error: 'Не удалось получить цены' });
        }

        const t1 = Date.now();
        // Indicators + news in parallel — slow news API never blocks beyond
        // the indicator computation budget.
        const [indicators, news] = await Promise.all([
            computeIndicators(prices),
            fetchLatestNews()
        ]);
        const shocks = computeShocks(indicators);
        const shockKeys = Object.keys(shocks);
        if (shockKeys.length) {
            console.log(`[portfolio] price shocks: ${shockKeys.join(',')}`);
        }
        console.log(`[portfolio] indicators: ${Object.keys(indicators).length} symbols, news: ${news.length} headlines in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators, shocks, news);

        const t2 = Date.now();
        const content = await callOpenRouter(prompt, apiKey);
        console.log(`[portfolio] openrouter responded in ${Date.now() - t2}ms`);

        const aiPairs = parseAIPairs(content);
        if (!aiPairs || aiPairs.length === 0) {
            return res.status(200).json({
                success: false,
                error: 'AI вернул некорректный список сделок',
                raw: content
            });
        }

        const pairs = aiPairs
            .map(normalisePair)
            .filter(p => p.pair && p.direction)
            // Post-validation pipeline:
            // 1) Kill trades on shocked pairs
            .map(p => enforceNoShockTrade(p, shocks[p.pair]))
            // 2) Enforce 4h trend alignment
            .map(p => enforce4hTrendAlignment(p, indicators))
            // 3) Demote thin RR
            .map(p => enforceMinRR(p));

        if (pairs.length === 0) {
            return res.status(200).json({
                success: false,
                error: 'AI вернул сделки в неподдерживаемом формате',
                raw: content
            });
        }

        return res.status(200).json({
            success: true,
            prices,
            pairs
        });
    } catch (e) {
        console.error('portfolio error:', e);
        return res.status(500).json({
            success: false,
            error: e.message || String(e)
        });
    }
};
