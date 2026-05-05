// Vercel Serverless Function: GET /api/analyze
// Returns ONE best trade recommendation produced strictly by the AI model.
// No hard-coded fallback values are returned: if the AI fails or returns an
// invalid signal, the response will be { success: false, error, raw }.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');

const SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT'
];
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

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

function buildPrompt(prices, indicators) {
    const priceLines = Object.entries(prices)
        .map(([s, p]) => `- ${s}: $${p}`)
        .join('\n');

    const indLines = Object.entries(indicators)
        .map(([s, b]) => formatIndicatorLine(s, b, prices[s]))
        .join('\n');

    return `Ты профессиональный криптотрейдер. Проанализируй рынок по нескольким индикаторам и дай ОДНУ лучшую рекомендацию строго в виде JSON-объекта.

Текущие цены:
${priceLines}

Технические индикаторы (1h timeframe) — RSI, MACD, EMA20/EMA50, Bollinger Bands (с %B), Stochastic %K, ATR, тренд, поддержка/сопротивление + история последних 8 свечей (close, ΔPрice, RSI, MACD_hist):
${indLines}

Используй комбинацию минимум 3 индикаторов (например, согласование RSI + MACD + EMA-кросс или Bollinger + Stoch + ATR), а не один RSI. Учитывай динамику последних 8 свечей: куда движутся цена и индикаторы (импульс, дивергенции, развороты), а не только мгновенный срез. Кратко обоснуй выбор парой индикаторов с упоминанием тренда последних свечей.

Верни JSON со следующими полями:
{
  "pair": "BTCUSDT",
  "direction": "LONG" | "SHORT" | "HET",
  "entryPrice": 12345.67,
  "tp": 13000.00,
  "sl": 12000.00,
  "confidence": 8,
  "reason": "Краткое обоснование на русском"
}

ПРАВИЛА TP/SL:
- LONG: TP > entryPrice, SL < entryPrice
- SHORT: TP < entryPrice, SL > entryPrice

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
            temperature: 0.2,
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
        console.log('[analyze] fetching prices...');
        const prices = await fetchPrices(SYMBOLS);
        console.log(`[analyze] prices: ${Object.keys(prices).length} symbols in ${Date.now() - t0}ms`);
        if (Object.keys(prices).length === 0) {
            return res.status(502).json({ success: false, error: 'Не удалось получить цены' });
        }

        const t1 = Date.now();
        const indicators = await computeIndicators(prices);
        console.log(`[analyze] indicators: ${Object.keys(indicators).length} symbols in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators);

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
