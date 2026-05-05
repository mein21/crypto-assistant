// Vercel Serverless Function: POST /api/portfolio
// Asks the AI to pick the 5 best trades across the supported symbols using
// the same multi-indicator bundle as /api/analyze (RSI + MACD + EMA +
// Bollinger + Stoch + ATR + 8-candle history). Returns ONLY what the AI
// produced. No hard-coded fallback values.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');
const { fetchLatestNews, formatNewsBlock, formatUpcomingHints } = require('./_news');
const { enforceMinRR } = require('./_rrGuard');

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
// User explicitly prefers the smarter `openai/gpt-oss-120b:free` over the
// faster 20b sibling — they're OK with /api/portfolio taking up to ~80s for
// better trade quality. The Vercel function `maxDuration` was bumped to 90s
// in vercel.json to match. OPENROUTER_PORTFOLIO_MODEL is honoured if set so
// the operator can still pin a different model without touching code.
const OPENROUTER_MODEL =
    process.env.OPENROUTER_PORTFOLIO_MODEL ||
    process.env.OPENROUTER_MODEL ||
    'openai/gpt-oss-120b:free';
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
            const candles = await fetchCandles(symbol, '1h', 100);
            if (!candles.length) return null;
            const bundle = buildIndicatorBundle(candles);
            if (!bundle) return null;
            return [symbol, bundle];
        } catch (e) {
            console.error(`indicator ${symbol}:`, e.message);
            return null;
        }
    }));
    return Object.fromEntries(results.filter(Boolean));
}

function buildPrompt(prices, indicators, news) {
    const priceLines = Object.entries(prices)
        .map(([s, p]) => `- ${s}: $${p}`)
        .join('\n');

    const indLines = Object.entries(indicators)
        .map(([s, b]) => formatIndicatorLine(s, b, prices[s]))
        .join('\n');

    const newsBlock = formatNewsBlock(news, Object.keys(prices));
    const newsSection = newsBlock
        ? `\nНовости (★ — пара из набора):\n${newsBlock}\n`
        : '';

    const upcoming = formatUpcomingHints();

    return `Ты профессиональный криптотрейдер. Дай 5 лучших сделок строго JSON-массивом.

Цены:
${priceLines}

Индикаторы (1h: RSI, MACD, EMA20/50, Bollinger %B, Stoch %K, ATR, тренд, S/R + 8 свечей):
${indLines}
${newsSection}
Календарь: ${upcoming}

ПРОЦЕДУРА (детерминированно, при равных данных — равный ответ):
1) По каждой паре балл = сумма голосов (LONG=+1/SHORT=-1/0) по 6 каналам: EMA-кросс, MACD-гист, RSI (>55 LONG, <45 SHORT), Stoch %K, Bollinger %B (>0.7 SHORT, <0.3 LONG), тренд+8 свечей.
2) Сортируй по |баллу| убыванию, бери топ-5.
3) Если |балл|<2 → direction="HET", reason="смешанные сигналы". Не угадывай.
4) Негатив в новостях (взлом/SEC) → снижай confidence или HET. Позитив (ETF) → +confidence на LONG.

CONFIDENCE — НЕ ставь 5 всем подряд. Считай по формуле от |балла|:
|балл|=0→4, |балл|=1→5, |балл|=2→6, |балл|=3→7, |балл|=4→8, |балл|=5→9, |балл|=6→10.
±1 за сильный новостной фон по этой паре.

REASON — строго на русском языке. Никаких английских слов («bullish», «hist positive», «trend up» и т.п.) — пиши «бычий», «гистограмма растёт», «восходящий тренд». Допустимы только аббревиатуры индикаторов (EMA, MACD, RSI, Stoch, Bollinger, %B, %K, ATR, S/R) и тикеры пар.

JSON-массив из 5:
[{"pair":"BTCUSDT","direction":"LONG|SHORT|HET","entryPrice":N,"tp":N,"sl":N,"confidence":1-10,"reason":"кратко по-русски: балл, индикаторы, новости"}]

LONG: TP>entry, SL<entry. SHORT: TP<entry, SL>entry. HET: entry/tp/sl можно null.
RR = (tp-entry)/(entry-sl) для LONG, (entry-tp)/(sl-entry) для SHORT. Допустимый RR зависит от уверенности:
- confidence ≥ 8 → RR ≥ 0.5
- confidence ≥ 6 → RR ≥ 1.0
- иначе → RR ≥ 1.5
RR ≤ 0 (TP на/за entry в неправильную сторону) — НИКОГДА. Лучше HET.
TP минимум на 0.2% от entry (round-trip taker fee Bybit 0.11%, иначе сделка убыточна по комиссии).
Только JSON, без markdown и комментариев.`;
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
            throw new Error(`OpenRouter не ответил за ${OPENROUTER_TIMEOUT_MS / 1000}с (модель ${OPENROUTER_MODEL}). Попробуй ещё раз или укажи более быструю модель в переменной OPENROUTER_PORTFOLIO_MODEL (например openai/gpt-oss-20b:free).`);
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
        console.log(`[portfolio] indicators: ${Object.keys(indicators).length} symbols, news: ${news.length} headlines in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators, news);

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
            // Demote LONG/SHORT trades whose RR < TRADING_MIN_RR (default 1.5)
            // to HET. The free model occasionally puts TP almost on top of
            // entry — that's a sub-1 RR after fees, i.e. guaranteed loss.
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
