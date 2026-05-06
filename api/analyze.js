// Vercel Serverless Function: GET /api/analyze
// Returns ONE best trade recommendation produced strictly by the AI model.
// No hard-coded fallback values are returned: if the AI fails or returns an
// invalid signal, the response will be { success: false, error, raw }.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');
const { fetchLatestNews, formatNewsBlock, formatUpcomingHints } = require('./_news');
const { enforceMinRR } = require('./_rrGuard');
const { detectPriceShock, formatShockTag, enforceNoShockTrade } = require('./_priceShock');

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
// NVIDIA Nemotron 3 Super: Finance #26, Programming #8 on OpenRouter.
// 120B-param MoE (12B active), stable free tier, 262K context.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
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

    return `Ты профессиональный инвестор-аналитик. Твоя цель — ПРИБЫЛЬНЫЕ сделки, а не количество. Лучше пропустить вход (HET), чем войти в убыточную сделку.

Цены:
${priceLines}

Индикаторы 1h (основной ТФ) + 4h (старший ТФ для подтверждения тренда):
Баллы уже посчитаны кодом: положительный = LONG сигнал, отрицательный = SHORT, 0 = нейтральный.
${indLines}
${newsSection}
Календарь: ${upcoming}

ПРАВИЛА ПРОФЕССИОНАЛЬНОГО ТРЕЙДЕРА:

ПРАВИЛО 1 — ТОРГУЙ ТОЛЬКО ПО ТРЕНДУ СТАРШЕГО ТФ:
- 4h тренд bullish или 4h БАЛЛ > 0 → разрешены ТОЛЬКО LONG сделки
- 4h тренд bearish или 4h БАЛЛ < 0 → разрешены ТОЛЬКО SHORT сделки
- 4h нейтральный И 4h БАЛЛ = 0 → direction="HET" (не торгуем в боковике)
НАРУШЕНИЕ ЭТОГО ПРАВИЛА = ГАРАНТИРОВАННЫЙ УБЫТОК.

ПРАВИЛО 2 — МИНИМУМ ПОДТВЕРЖДЕНИЙ:
- 1h БАЛЛ должен совпадать по знаку с 4h (оба LONG или оба SHORT)
- |1h БАЛЛ| ≥ 3 (сильный сигнал) — иначе HET
- Если есть ДИВЕРГЕНЦИЯ — снижай доверие на 2 пункта
- Если объём слабый (< x0.7) — сигнал ненадёжный, снижай доверие

ПРАВИЛО 3 — ЦЕНА ВЫШЕ EMA200 = LONG ЗОНА, НИЖЕ = SHORT ЗОНА:
- Цена выше EMA200 → подтверждение для LONG. Если сигнал SHORT при цене выше EMA200 → HET
- Цена ниже EMA200 → подтверждение для SHORT. Если сигнал LONG при цене ниже EMA200 → HET

ПРАВИЛО 4 — TP/SL ПО СТРУКТУРЕ РЫНКА:
- SL: за ближайшим уровнем поддержки (LONG) или сопротивления (SHORT) из S/R данных + 0.3×ATR запас
- TP: до ближайшего S/R уровня в направлении сделки ИЛИ 2-3×ATR
- НЕ ставь TP за сильный уровень сопротивления (LONG) / поддержки (SHORT) — цена отскочит
- Проверь: SL НЕ в зоне шума (не ближе 0.8×ATR от entry)

ПРАВИЛО 5 — CONFIDENCE строго по данным:
|1h БАЛЛ|=3 → conf=5, |1h БАЛЛ|=4 → conf=6, |1h БАЛЛ|=5 → conf=7, |1h БАЛЛ|=6 → conf=8, |1h БАЛЛ|≥7 → conf=9
+1 если 4h БАЛЛ сильный (|4h БАЛЛ|≥3), -1 если дивергенция, -1 если объём слабый, ±1 новости.

ПРАВИЛО 6 — ШОК = НЕ ТОРГУЕМ:
Если у пары стоит ⚠️ ШОК — direction ОБЯЗАТЕЛЬНО "HET".

ПРАВИЛО 7 — RR:
RR = (tp-entry)/(entry-sl) для LONG, (entry-tp)/(sl-entry) для SHORT.
Минимум RR ≥ 1.5 (conf≥8 → RR≥0.5, conf≥6 → RR≥1.0). RR ≤ 0 — НИКОГДА.
TP минимум на 0.2% от entry (комиссия 0.11%).

REASON — строго русский. Формат: «1h балл=N, 4h балл=N; [ключевые сигналы]; S/R: вход у $X, TP до $Y; RR≈X.X».

JSON (ТОЛЬКО JSON, без markdown):
{"pair":"BTCUSDT","direction":"LONG|SHORT|HET","entryPrice":N,"tp":N,"sl":N,"confidence":1-10,"reason":"кратко"}

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

    // Check 4h trend alignment
    const h4Bullish = h4Trend === 'bullish' || h4Score > 0;
    const h4Bearish = h4Trend === 'bearish' || h4Score < 0;

    let demote = false;
    if (dir === 'LONG' && h4Bearish) demote = true;
    if (dir === 'SHORT' && h4Bullish) demote = true;
    // Neutral 4h = no clear trend = don't trade
    if (!h4Bullish && !h4Bearish) demote = true;

    // Check EMA200 alignment
    if (h4.ema200 != null && h4.lastClose != null) {
        if (dir === 'LONG' && h4.lastClose < h4.ema200) demote = true;
        if (dir === 'SHORT' && h4.lastClose > h4.ema200) demote = true;
    }

    if (!demote) return trade;

    const note = `[4h тренд=${h4Trend}, 4h балл=${h4Score} — сделка против старшего ТФ, пропуск]`;
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
        const shocks = computeShocks(indicators);
        const shockKeys = Object.keys(shocks);
        if (shockKeys.length) {
            console.log(`[analyze] price shocks: ${shockKeys.join(',')}`);
        }
        console.log(`[analyze] indicators: ${Object.keys(indicators).length} symbols, news: ${news.length} headlines in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators, shocks, news);

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

        // Post-validation pipeline:
        // 1) Kill trades on shocked symbols
        const noShockTrade = enforceNoShockTrade(rawTrade, shocks[rawTrade.pair]);

        // 2) Enforce 4h trend alignment — trades against higher TF are demoted
        const trendChecked = enforce4hTrendAlignment(noShockTrade, indicators);

        // 3) Demote thin RR
        const trade = enforceMinRR(trendChecked);

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
