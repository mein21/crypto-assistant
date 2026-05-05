// Vercel Serverless Function: GET /api/analyze
// Returns ONE best trade recommendation produced strictly by the AI model.
// No hard-coded fallback values are returned: if the AI fails or returns an
// invalid signal, the response will be { success: false, error, raw }.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');
const { fetchLatestNews, formatNewsBlock, formatUpcomingHints } = require('./_news');

// Default symbol set when the client doesn't pass one via `?symbols=`.
const DEFAULT_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT'
];
// Allowlist of pairs the backend has decimal/tick-size data for. Anything
// outside this set would be rejected by Bybit at order time, so we don't
// even ask the AI to consider them.
const SUPPORTED_SYMBOLS = new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT',
    'LTCUSDT', 'LINKUSDT', 'MATICUSDT'
]);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

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
        ? `\nНовостной фон (последние 24ч, ★ — пара из текущего набора):\n${newsBlock}\n`
        : '\nНовостной фон: данных нет (пропусти этот блок в анализе).\n';

    const upcoming = formatUpcomingHints();

    return `Ты профессиональный криптотрейдер. Проанализируй рынок по нескольким индикаторам и дай ОДНУ лучшую рекомендацию строго в виде JSON-объекта.

Текущие цены:
${priceLines}

Технические индикаторы (1h timeframe) — RSI, MACD, EMA20/EMA50, Bollinger Bands (с %B), Stochastic %K, ATR, тренд, поддержка/сопротивление + история последних 8 свечей (close, ΔPрice, RSI, MACD_hist):
${indLines}
${newsSection}
Предстоящие события: ${upcoming}

ПРОЦЕДУРА ВЫБОРА НАПРАВЛЕНИЯ (выполняй строго по порядку, не пропускай шаги):
1. Для каждой пары посчитай "балл сигнала" = сумма голосов (LONG=+1, SHORT=-1, нейтрально=0) по шести каналам:
   • EMA-кросс (EMA20 vs EMA50);
   • MACD-гистограмма (знак + динамика последних 3 свечей);
   • RSI (>55 LONG, <45 SHORT, 45-55 нейтрально; учти разворот в истории);
   • Stochastic %K (>50 + растёт LONG, <50 + падает SHORT);
   • Bollinger %B (>0.7 перекуп → SHORT bias, <0.3 перепрод → LONG bias, иначе по тренду);
   • Тренд + последние 8 свечей (3+ зелёных подряд = LONG, 3+ красных = SHORT).
2. Выбирай пару с МАКСИМАЛЬНЫМ |баллом|. Если у двух пар |балл| равны — бери ту, где ATR% выше (больше волатильности = больше потенциала).
3. Если |балл| у лучшей пары < 3 ИЛИ голоса распределены 3/3 (сильный конфликт) — верни direction="HET" с reason="смешанные сигналы, ждём подтверждения" и НЕ выдумывай LONG/SHORT.
4. Учитывай новостной фон: сильный негатив по монете (взлом, иск SEC, делистинг) — снижай confidence или переключайся на HET. Сильный позитив по макро (одобрение ETF, дешёвые деньги) — повышай confidence на LONG.
5. Будь ДЕТЕРМИНИСТИЧЕН: при одинаковых данных всегда давай одинаковый ответ. Не "перебирай" пары случайно — следуй процедуре.

ВАЖНО: запрещено возвращать LONG если 3+ голосов SHORT, и наоборот. Если ты не уверен — это HET, а не угадывание.

ОТВЕТ — строго JSON со следующими полями:
{
  "pair": "BTCUSDT",
  "direction": "LONG" | "SHORT" | "HET",
  "entryPrice": 12345.67,
  "tp": 13000.00,
  "sl": 12000.00,
  "confidence": 8,
  "reason": "Краткое обоснование на русском (укажи итоговый балл сигнала, ключевые индикаторы и упомяни новостной фон, если он повлиял)"
}

ПРАВИЛА TP/SL:
- LONG: TP > entryPrice, SL < entryPrice
- SHORT: TP < entryPrice, SL > entryPrice
- При direction="HET" entryPrice/tp/sl можно вернуть null.

Верни ТОЛЬКО JSON-объект без markdown-обёртки и без любого текста до или после.`;
}

async function callOpenRouter(prompt, apiKey) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            max_tokens: 1500,
            // temperature 0 makes the model deterministic for identical
            // input. The user complained that hitting "Best trade" twice
            // could flip BTC from SHORT to LONG with the same data — that
            // was 0.2 sampling. seed pins it where the model supports it.
            temperature: 0,
            top_p: 1,
            seed: 42,
            messages: [{ role: 'user', content: prompt }]
        })
    });

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
        const trade = {
            pair: String(aiTrade.pair).replace('/', ''),
            direction: String(aiTrade.direction).toUpperCase(),
            entryPrice: toNumberOrNull(aiTrade.entryPrice),
            tp: toNumberOrNull(aiTrade.tp),
            sl: toNumberOrNull(aiTrade.sl),
            confidence: toNumberOrNull(aiTrade.confidence),
            reason: aiTrade.reason ? String(aiTrade.reason) : ''
        };

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
