// Vercel Serverless Function: POST /api/portfolio/analyze
// Pulls live wallet snapshot from Bybit (via the Cloudflare Worker proxy),
// computes indicators for every held coin, asks the AI for a portfolio
// review, and returns ONLY what the AI produced (no hard-coded fallback).

const { fetchPrices, fetchCandles } = require('../_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../../utils/indicatorBundle');
const {
    getUSDTBalance,
    getAllCoins,
    getOpenOrders,
    getOrderHistory,
    getWorkerOverrides,
    setCors,
    errorPayload
} = require('../_bybit');

const SUPPORTED = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT', 'MATICUSDT'];

function parseAIAnalysis(content) {
    if (!content) return null;
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); }
    catch (_) { return null; }
}

async function callOpenRouter(prompt, apiKey) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
            max_tokens: 1200,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`OpenRouter HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '';
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            success: false,
            error: 'OPENROUTER_API_KEY не настроен в Vercel (Settings → Environment Variables, нужен Redeploy).'
        });
    }

    try {
        const t0 = Date.now();

        const opts = getWorkerOverrides(req);
        const [rawBalance, coins, prices, openOrders, orderHistory] = await Promise.all([
            getUSDTBalance(opts).catch(() => 0),
            getAllCoins(opts).catch(() => ({})),
            fetchPrices(SUPPORTED),
            getOpenOrders('linear', opts).catch(() => []),
            getOrderHistory('linear', 100, opts).catch(() => [])
        ]);
        console.log(`[portfolio/analyze] bybit+prices fetched in ${Date.now() - t0}ms`);

        const assets = Object.entries(coins)
            .filter(([coin, qty]) => qty > 0 && coin !== 'USDT')
            .map(([coin, qty]) => {
                const symbol = `${coin}USDT`;
                const price = prices[symbol] || 0;
                return { coin, qty, price, value: qty * price };
            });
        const filtered = assets.filter(a => a.value >= 1);

        const t1 = Date.now();
        const indicatorsMap = {};
        await Promise.all(filtered.map(async (a) => {
            const symbol = `${a.coin}USDT`;
            try {
                const candles = await fetchCandles(symbol, '1h', 100);
                const bundle = buildIndicatorBundle(candles);
                if (bundle) indicatorsMap[a.coin] = bundle;
            } catch (e) {
                console.warn(`[portfolio/analyze] indicators ${symbol} failed:`, e.message);
            }
        }));
        console.log(`[portfolio/analyze] indicators in ${Date.now() - t1}ms`);

        const tpslOrders = openOrders.filter(o =>
            o.orderStatus === 'Untriggered' && (o.stopOrderType === 'Stop' || o.stopOrderType === 'tpslOrder')
        );
        const filledBuys = orderHistory.filter(o => o.orderStatus === 'Filled' && o.side === 'Buy');

        const openPositions = filtered.map(a => {
            const symbol = `${a.coin}USDT`;
            const tpOrder = tpslOrders.find(o => o.symbol === symbol && o.side === 'Sell');
            const buys = filledBuys.filter(o => o.symbol === symbol);

            let avgPrice = a.price;
            if (buys.length) {
                let qtySum = 0, valueSum = 0;
                for (const o of buys) {
                    const q = parseFloat(o.cumExecQty) || 0;
                    const p = parseFloat(o.avgPrice) || 0;
                    qtySum += q;
                    valueSum += q * p;
                }
                if (qtySum > 0) avgPrice = valueSum / qtySum;
            } else if (tpOrder && tpOrder.basePrice) {
                avgPrice = parseFloat(tpOrder.basePrice) || a.price;
            }

            let tp = null, sl = null, tpChance = null, slChance = null;
            const trigger = tpOrder ? parseFloat(tpOrder.triggerPrice) : NaN;
            if (Number.isFinite(trigger) && a.price > 0) {
                if (trigger > a.price) {
                    tp = trigger;
                    tpChance = Math.max(0, Math.round(100 - ((tp - a.price) / a.price) * 100));
                } else {
                    sl = trigger;
                    slChance = Math.max(0, Math.round(100 - ((a.price - sl) / a.price) * 100));
                }
            }

            return {
                symbol: a.coin,
                qty: a.qty,
                avgPrice,
                currentPrice: a.price,
                value: a.value,
                tp,
                sl,
                tpChance,
                slChance,
                side: 'LONG'
            };
        });

        const totalValue = filtered.reduce((s, a) => s + a.value, 0);
        const activeBalance = rawBalance + totalValue;

        const positionLines = openPositions.length
            ? openPositions.map(p => {
                let info = '';
                if (p.tp) info = `TP: $${p.tp} (шанс ${p.tpChance}%)`;
                else if (p.sl) info = `SL: $${p.sl} (шанс ${p.slChance}%)`;
                else info = 'TP/SL не установлены';
                return `- ${p.symbol}: ${p.qty.toFixed(4)} @ avg $${p.avgPrice.toFixed(4)}, текущая $${p.currentPrice.toFixed(4)}, ${info}`;
            }).join('\n')
            : 'Нет открытых позиций';

        const indicatorLines = Object.entries(indicatorsMap)
            .map(([coin, bundle]) => {
                const livePrice = prices[`${coin}USDT`];
                return formatIndicatorLine(coin, bundle, livePrice);
            }).join('\n') || 'нет данных';

        const prompt = `Ты профессиональный криптотрейдер. Проанализируй мой портфель на основе нескольких индикаторов и текущих цен. Отвечай ТОЛЬКО на русском языке.

Активный баланс (USDT + позиции > $1): $${activeBalance.toFixed(2)}
Свободные USDT: $${rawBalance.toFixed(2)}

Технические индикаторы по моим монетам (1h timeframe) — RSI, MACD, EMA20/EMA50, Bollinger Bands (с %B), Stochastic %K, ATR, тренд, поддержка/сопротивление + история последних 8 свечей (close, ΔPрice, RSI, MACD_hist):
${indicatorLines}

Опирайся на согласование минимум 3 индикаторов (например, RSI + MACD + EMA-кросс, либо Bollinger + Stoch + ATR), а не на один RSI. Учитывай динамику последних 8 свечей: импульс цены, изменение RSI и MACD-гистограммы, возможные дивергенции — а не только мгновенные значения.

Открытые позиции:
${positionLines}

Верни строгий JSON и НИЧЕГО кроме него:
{
  "summary": "общее резюме портфеля 1-2 предложения",
  "strengths": "сильные стороны 1-2 предложения",
  "weaknesses": "слабые стороны 1-2 предложения",
  "suggestions": "общие рекомендации 1-2 предложения",
  "tpRecommendations": "общая стратегия по TP/SL 1-2 предложения",
  "positions": [
    { "symbol": "BTC", "tp": 95000, "sl": 78000, "tpReason": "почему такой TP", "slReason": "почему такой SL" }
  ]
}`;

        const t2 = Date.now();
        const aiContent = await callOpenRouter(prompt, apiKey);
        console.log(`[portfolio/analyze] openrouter in ${Date.now() - t2}ms`);

        const analysis = parseAIAnalysis(aiContent);
        if (!analysis) {
            return res.status(200).json({
                success: false,
                error: 'AI вернул некорректный анализ',
                raw: aiContent,
                openPositions
            });
        }

        return res.status(200).json({ success: true, analysis, openPositions });
    } catch (e) {
        console.error('portfolio/analyze error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
