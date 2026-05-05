// Vercel Serverless Function: GET /api/analyze
// Returns ONE best trade recommendation produced strictly by the AI model.
// No hard-coded fallback values are returned: if the AI fails or returns an
// invalid signal, the response will be { success: false, error, raw }.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');
const { fetchLatestNews, formatNewsBlock, formatUpcomingHints } = require('./_news');
const { enforceMinRR, DEFAULT_MIN_RR } = require('./_rrGuard');

// Default symbol set when the client doesn't pass one via `?symbols=`.
// Pairs priced in 4+ decimals (ADA/DOGE/MATIC) are intentionally excluded
// from the trading universe — their tick size is small enough that the
// model frequently produces TP/SL pairs whose RR rounds to 0.
const DEFAULT_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT'
];
// Allowlist of pairs the backend has decimal/tick-size data for AND that
// we're willing to trade. Anything outside this set would be rejected at
// order time, so we don't even ask the AI to consider them.
const SUPPORTED_SYMBOLS = new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT'
]);
// User prefers the smarter 120b model over the faster 20b sibling. Vercel
// function maxDuration was bumped to 90s in vercel.json so a single trade
// fits comfortably even at ~21 tok/s on the free OpenInference provider.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';
// Hard ceiling on the OpenRouter call so a slow upstream returns a clean
// error instead of letting Vercel kill the function. Sized just under
// Vercel's 90s maxDuration.
const OPENROUTER_TIMEOUT_MS = 80_000;

// Parse `?symbols=BTCUSDT,ETHUSDT` (case-insensitive, validated against
// SUPPORTED_SYMBOLS, deduped). Returns DEFAULT_SYMBOLS on empty or invalid
// input so the endpoint behaves the same as before for clients that don't
// pass the param.
function pickSymbolsFromQuery(req) {
    const raw = (req.query && req.query.symbols) || '';
    if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_SYMBOLS.slice();
    const seen = new Set();
    const out = [];
    for (const part of raw.split(',')) {
        const sym = part.trim().toUpperCase();
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

    return `Ты профессиональный криптотрейдер. Дай ОДНУ лучшую сделку строго JSON.

Цены:
${priceLines}

Индикаторы (1h: RSI, MACD, EMA20/50, Bollinger %B, Stoch %K, ATR, тренд, S/R + 8 свечей):
${indLines}
${newsSection}
Календарь: ${upcoming}

ПРОЦЕДУРА (детерминированно, при равных данных — равный ответ):
1) По каждой паре считай балл = сумма голосов (LONG=+1/SHORT=-1/0) по 6 каналам: EMA-кросс, MACD-гист, RSI (>55 LONG, <45 SHORT), Stoch %K, Bollinger %B (>0.7 SHORT bias, <0.3 LONG bias), тренд+8 свечей.
2) Бери пару с максимальным |баллом| (ничья → выше ATR%).
3) Если |балл|<3 или конфликт 3/3 → direction="HET", reason="смешанные сигналы". Не угадывай.
4) Сильный негатив в новостях (взлом/SEC) → снижай confidence или HET. Сильный позитив (ETF) → +confidence на LONG.

CONFIDENCE — НЕ ставь 5 «по умолчанию». Считай по формуле от |балла|:
|балл|=0→4, |балл|=1→5, |балл|=2→6, |балл|=3→7, |балл|=4→8, |балл|=5→9, |балл|=6→10.
±1 за сильный новостной фон по этой паре.

REASON — строго на русском языке. Никаких английских слов («bullish», «hist positive», «trend up» и т.п.) — пиши «бычий», «гистограмма растёт», «восходящий тренд». Допустимы только аббревиатуры индикаторов (EMA, MACD, RSI, Stoch, Bollinger, %B, %K, ATR, S/R) и тикеры пар.

JSON:
{"pair":"BTCUSDT","direction":"LONG|SHORT|HET","entryPrice":N,"tp":N,"sl":N,"confidence":1-10,"reason":"кратко по-русски: балл, ключевые индикаторы, новости если повлияли"}

LONG: TP>entry, SL<entry. SHORT: TP<entry, SL>entry. HET: entry/tp/sl можно null.
RR (reward/risk) ≥ ${DEFAULT_MIN_RR}: для LONG (tp-entry)/(entry-sl) ≥ ${DEFAULT_MIN_RR}; для SHORT (entry-tp)/(sl-entry) ≥ ${DEFAULT_MIN_RR}. RR ниже — это HET, никогда не давай LONG/SHORT с RR<${DEFAULT_MIN_RR}.
TP минимум на 0.2% от entry (round-trip taker fee Bybit 0.11%).
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
                // Single concise trade fits in <500 tokens; 700 leaves comfortable
                // headroom but keeps OpenRouter fast.
                max_tokens: 700,
                // temperature 0 makes the model deterministic for identical
                // input. User complained that hitting "Best trade" twice could
                // flip BTC from SHORT to LONG on the same data — that was 0.2
                // sampling. seed pins it where the model supports it.
                temperature: 0,
                top_p: 1,
                seed: 42,
                messages: [{ role: 'user', content: prompt }]
            })
        });
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
            throw new Error(`OpenRouter не ответил за ${OPENROUTER_TIMEOUT_MS / 1000}с (модель ${OPENROUTER_MODEL}). Попробуй ещё раз или укажи более быструю модель в переменной OPENROUTER_MODEL (например openai/gpt-oss-20b:free).`);
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

function parseAITrade(content) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function toNumberOrNull(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
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
        const symbols = pickSymbolsFromQuery(req);
        console.log(`[analyze] fetching prices for ${symbols.length} symbols: ${symbols.join(',')}`);
        const prices = await fetchPrices(symbols);
        console.log(`[analyze] prices: ${Object.keys(prices).length} symbols in ${Date.now() - t0}ms`);
        if (Object.keys(prices).length === 0) {
            return res.status(502).json({ success: false, error: 'Не удалось получить цены' });
        }

        const t1 = Date.now();
        // Fetch indicators and news in parallel — news is non-critical so
        // we never let a slow news API delay the analysis past its own
        // computation.
        const [indicators, news] = await Promise.all([
            computeIndicators(prices),
            fetchLatestNews()
        ]);
        console.log(`[analyze] indicators: ${Object.keys(indicators).length} symbols, news: ${news.length} headlines in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators, news);

        const t2 = Date.now();
        const content = await callOpenRouter(prompt, apiKey);
        console.log(`[analyze] openrouter responded in ${Date.now() - t2}ms`);

        const aiTrade = parseAITrade(content);
        if (!aiTrade || !aiTrade.pair || !aiTrade.direction) {
            return res.status(200).json({
                success: false,
                error: 'AI вернул некорректный сигнал',
                raw: content
            });
        }

        // Strictly use AI-provided values; only normalise numeric types so the
        // frontend can call .toLocaleString() / .toFixed() without crashing.
        const rawTrade = {
            pair: String(aiTrade.pair).replace('/', ''),
            direction: String(aiTrade.direction).toUpperCase(),
            entryPrice: toNumberOrNull(aiTrade.entryPrice),
            tp: toNumberOrNull(aiTrade.tp),
            sl: toNumberOrNull(aiTrade.sl),
            confidence: toNumberOrNull(aiTrade.confidence),
            reason: aiTrade.reason ? String(aiTrade.reason) : ''
        };

        // Demote LONG/SHORT trades whose RR < TRADING_MIN_RR (default 1.5)
        // to HET. The free model occasionally proposes TP almost on top of
        // entry — that's a sub-1 RR after fees, i.e. guaranteed loss.
        const trade = enforceMinRR(rawTrade);

        return res.status(200).json({
            success: true,
            prices,
            trade
        });
    } catch (e) {
        console.error('analyze error:', e);
        return res.status(500).json({
            success: false,
            error: e.message || String(e)
        });
    }
};
