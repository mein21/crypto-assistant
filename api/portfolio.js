// Vercel Serverless Function: POST /api/portfolio
// Asks the AI to pick the 5 best trades across the supported symbols using
// the same multi-indicator bundle as /api/analyze (RSI + MACD + EMA +
// Bollinger + Stoch + ATR + 8-candle history). Returns ONLY what the AI
// produced. No hard-coded fallback values.

const { fetchPrices, fetchCandles } = require('./_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../utils/indicatorBundle');

// Default symbol set when the client doesn't pass one. Must be a subset of
// the backend's supported pairs (see PRICE_DECIMALS in api/_bybit.js).
const DEFAULT_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT'
];
const SUPPORTED_SYMBOLS = new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT',
    'LTCUSDT', 'LINKUSDT', 'MATICUSDT'
]);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

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

function buildPrompt(prices, indicators) {
    const priceLines = Object.entries(prices)
        .map(([s, p]) => `- ${s}: $${p}`)
        .join('\n');

    const indLines = Object.entries(indicators)
        .map(([s, b]) => formatIndicatorLine(s, b, prices[s]))
        .join('\n');

    return `Ты профессиональный криптотрейдер. Выбери 5 лучших сделок на основе данных ниже и верни их строго в виде JSON-массива.

Текущие цены:
${priceLines}

Технические индикаторы (1h timeframe) — RSI, MACD, EMA20/EMA50, Bollinger Bands (с %B), Stochastic %K/%D, ATR, тренд, поддержка/сопротивление + история последних 8 свечей (close, ΔPрice, RSI, MACD_hist):
${indLines}

Используй комбинацию минимум 3 индикаторов (например, согласование RSI + MACD + EMA-кросс или Bollinger + Stoch + ATR), а не один RSI. Учитывай динамику последних 8 свечей: куда движутся цена и индикаторы (импульс, дивергенции, развороты), а не только мгновенный срез. Кратко обоснуй выбор парой индикаторов с упоминанием тренда последних свечей.

Верни строго JSON-массив из 5 элементов, без markdown, без пояснений до или после:
[
  {
    "pair": "BTCUSDT",
    "direction": "LONG" | "SHORT" | "HET",
    "entryPrice": 12345.67,
    "tp": 13000.00,
    "sl": 12000.00,
    "confidence": 8,
    "reason": "Краткое обоснование на русском"
  }
]

ПРАВИЛА:
- LONG: TP > entryPrice, SL < entryPrice
- SHORT: TP < entryPrice, SL > entryPrice
- TP должен быть как минимум на 0.2% от entryPrice (для LONG: tp >= entryPrice * 1.002; для SHORT: tp <= entryPrice * 0.998). Round-trip taker fee Bybit = 0.11% (0.055% × 2), TP ближе 0.11% от entry — гарантированный убыток после комиссии. 0.2% даёт минимальный профит сверху комиссии.
- confidence — целое число от 1 до 10, где 10 — максимальная уверенность.`;
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
            max_tokens: 2500,
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
        const indicators = await computeIndicators(prices);
        console.log(`[portfolio] indicators: ${Object.keys(indicators).length} symbols in ${Date.now() - t1}ms`);
        const prompt = buildPrompt(prices, indicators);

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
            .filter(p => p.pair && p.direction);

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
