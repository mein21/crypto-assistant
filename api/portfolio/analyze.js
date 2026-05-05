// Vercel Serverless Function: POST /api/portfolio/analyze
// Pulls live wallet snapshot from Bybit (via the Cloudflare Worker proxy),
// computes indicators for every held coin, asks the AI for a portfolio
// review, and returns ONLY what the AI produced (no hard-coded fallback).

const { fetchPrices, fetchCandles } = require('../_marketData');
const { buildIndicatorBundle, formatIndicatorLine } = require('../../utils/indicatorBundle');
const { touchChance } = require('../../utils/touchProbability');
const {
    getAccountSummary,
    getAllCoins,
    getOpenOrders,
    getOrderHistory,
    getFuturesPositions,
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
        const [accountSummary, coins, prices, openOrders, orderHistory, futuresPositions] = await Promise.all([
            getAccountSummary(opts).catch(() => ({
                wallet: 0, equity: 0, available: 0, unrealisedPnl: 0,
                totalEquity: 0, totalAvailableBalance: 0, totalWalletBalance: 0
            })),
            getAllCoins(opts).catch(() => ({})),
            fetchPrices(SUPPORTED),
            getOpenOrders('linear', opts).catch(() => []),
            getOrderHistory('linear', 100, opts).catch(() => []),
            getFuturesPositions(opts).catch((e) => {
                console.warn('[portfolio/analyze] getFuturesPositions failed:', e.message);
                return [];
            })
        ]);
        const rawBalance = accountSummary.wallet;
        console.log(`[portfolio/analyze] bybit+prices fetched in ${Date.now() - t0}ms`);

        const assets = Object.entries(coins)
            .filter(([coin, qty]) => qty > 0 && coin !== 'USDT')
            .map(([coin, qty]) => {
                const symbol = `${coin}USDT`;
                const price = prices[symbol] || 0;
                return { coin, qty, price, value: qty * price };
            });
        const filtered = assets.filter(a => a.value >= 1);

        // Pull live prices for any futures-only symbols not in the SUPPORTED set,
        // so indicator/prompt formatting has accurate values for them too.
        const futuresSymbols = futuresPositions.map(p => p.symbol);
        const missingPriceSymbols = futuresSymbols.filter(s => !prices[s]);
        if (missingPriceSymbols.length) {
            try {
                const more = await fetchPrices(missingPriceSymbols);
                Object.assign(prices, more);
            } catch (e) {
                console.warn('[portfolio/analyze] fetchPrices(extra) failed:', e.message);
            }
        }

        // Compute indicators for every coin we hold (spot or futures), deduped.
        const indicatorTargets = new Set();
        filtered.forEach(a => indicatorTargets.add(`${a.coin}USDT`));
        futuresSymbols.forEach(s => indicatorTargets.add(s));

        const t1 = Date.now();
        const indicatorsMap = {};
        await Promise.all([...indicatorTargets].map(async (symbol) => {
            const coin = symbol.replace(/USDT$/, '');
            try {
                const candles = await fetchCandles(symbol, '1h', 100);
                const bundle = buildIndicatorBundle(candles);
                if (bundle) indicatorsMap[coin] = bundle;
            } catch (e) {
                console.warn(`[portfolio/analyze] indicators ${symbol} failed:`, e.message);
            }
        }));
        console.log(`[portfolio/analyze] indicators in ${Date.now() - t1}ms`);

        const tpslOrders = openOrders.filter(o =>
            o.orderStatus === 'Untriggered' && (o.stopOrderType === 'Stop' || o.stopOrderType === 'tpslOrder')
        );
        const filledBuys = orderHistory.filter(o => o.orderStatus === 'Filled' && o.side === 'Buy');

        const spotPositions = filtered.map(a => {
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

            let tp = null, sl = null;
            const trigger = tpOrder ? parseFloat(tpOrder.triggerPrice) : NaN;
            if (Number.isFinite(trigger) && a.price > 0) {
                if (trigger > a.price) tp = trigger;
                else sl = trigger;
            }

            const atr = indicatorsMap[a.coin]?.atr;
            const tpChance = tp != null ? touchChance(a.price, tp, atr) : null;
            const slChance = sl != null ? touchChance(a.price, sl, atr) : null;

            return {
                kind: 'spot',
                symbol: a.coin,
                pair: symbol,
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

        const futuresOpenPositions = futuresPositions.map(p => {
            const coin = p.symbol.replace(/USDT$/, '');
            const livePrice = prices[p.symbol] || p.markPrice || 0;
            const atr = indicatorsMap[coin]?.atr;
            return {
                kind: 'futures',
                symbol: coin,
                pair: p.symbol,
                side: p.side,
                leverage: p.leverage,
                qty: p.size,
                avgPrice: p.avgPrice,
                currentPrice: livePrice,
                markPrice: p.markPrice,
                value: p.positionValue,
                unrealisedPnl: p.unrealisedPnl,
                liqPrice: p.liqPrice,
                tp: p.takeProfit,
                sl: p.stopLoss,
                tpChance: p.takeProfit != null ? touchChance(livePrice, p.takeProfit, atr) : null,
                slChance: p.stopLoss != null ? touchChance(livePrice, p.stopLoss, atr) : null
            };
        });

        const openPositions = [...spotPositions, ...futuresOpenPositions];

        const spotValue = spotPositions.reduce((s, p) => s + (p.value || 0), 0);
        const futuresUnrealised = futuresOpenPositions.reduce((s, p) => s + (p.unrealisedPnl || 0), 0);
        const futuresNotional = futuresOpenPositions.reduce((s, p) => s + (p.value || 0), 0);

        // Bybit's UTA "totalEquity" already includes USDT cash + all non-USDT
        // spot holdings (at mark price) + unrealised PnL of every open
        // position. That is exactly the live "portfolio value" the user sees
        // inside the Bybit app. Fall back to our manual sum only if the API
        // didn't return totalEquity (older account types, cold cache, etc.).
        const liveEquity = accountSummary.totalEquity > 0
            ? accountSummary.totalEquity
            : (accountSummary.equity || 0) + spotValue;
        const activeBalance = liveEquity > 0
            ? liveEquity
            : rawBalance + spotValue + futuresUnrealised;

        const spotLines = spotPositions.length
            ? spotPositions.map(p => {
                let info = '';
                if (p.tp) info = `TP: $${p.tp} (шанс ${p.tpChance}%)`;
                else if (p.sl) info = `SL: $${p.sl} (шанс ${p.slChance}%)`;
                else info = 'TP/SL не установлены';
                return `- ${p.symbol}: ${p.qty.toFixed(4)} @ avg $${p.avgPrice.toFixed(4)}, текущая $${p.currentPrice.toFixed(4)}, ${info}`;
            }).join('\n')
            : 'Нет открытых спотовых позиций';

        const futuresLines = futuresOpenPositions.length
            ? futuresOpenPositions.map(p => {
                const lev = p.leverage ? `${p.leverage}x` : 'плечо?';
                const tpPart = p.tp
                    ? `TP $${p.tp}${p.tpChance != null ? ` (шанс ${p.tpChance}%)` : ''}`
                    : 'TP не задан';
                const slPart = p.sl
                    ? `SL $${p.sl}${p.slChance != null ? ` (шанс ${p.slChance}%)` : ''}`
                    : 'SL не задан';
                const liqPart = p.liqPrice ? `, ликв. $${p.liqPrice}` : '';
                const pnlSign = p.unrealisedPnl >= 0 ? '+' : '';
                const pnlPart = Number.isFinite(p.unrealisedPnl)
                    ? `, нереал. PnL ${pnlSign}$${p.unrealisedPnl.toFixed(2)}`
                    : '';
                return `- ${p.symbol} ${p.side} ${lev}: ${p.qty} @ avg $${p.avgPrice}, mark $${p.markPrice} (notional $${p.value.toFixed(2)})${pnlPart}, ${tpPart}, ${slPart}${liqPart}`;
            }).join('\n')
            : 'Нет открытых фьючерсных позиций';

        const indicatorLines = Object.entries(indicatorsMap)
            .map(([coin, bundle]) => {
                const livePrice = prices[`${coin}USDT`];
                return formatIndicatorLine(coin, bundle, livePrice);
            }).join('\n') || 'нет данных';

        // Free margin Bybit actually checks at /v5/order/create — UTA-level
        // `totalAvailableBalance` (USD across all enabled-for-trade coins).
        // Per-USDT `availableToWithdraw` is restrictive (off-exchange-withdrawal
        // only) and is often 0 on UTA even when the account has plenty for new
        // orders, but we keep it as a defensive max() for older Classic accounts
        // that don't populate the UTA-level field.
        const freeMargin = Math.max(
            accountSummary.totalAvailableBalance || 0,
            accountSummary.available || 0
        );

        const prompt = `Ты профессиональный криптотрейдер. Проанализируй мой портфель на основе нескольких индикаторов и текущих цен. Отвечай ТОЛЬКО на русском языке.

Активный баланс (live equity всего UTA-аккаунта = USDT-кеш + все спот-холдинги по mark + нереал. PnL открытых позиций): $${activeBalance.toFixed(2)}
USDT walletBalance: $${rawBalance.toFixed(2)} (свободно под новый ордер: $${freeMargin.toFixed(2)}, нереал. PnL по USDT: ${(accountSummary.unrealisedPnl || 0) >= 0 ? '+' : ''}$${(accountSummary.unrealisedPnl || 0).toFixed(2)})
Спот-холдинги (без USDT, по mark-price): $${spotValue.toFixed(2)}
Открытая фьючерсная экспозиция (notional): $${futuresNotional.toFixed(2)}, нереал. PnL: ${futuresUnrealised >= 0 ? '+' : ''}$${futuresUnrealised.toFixed(2)}

Технические индикаторы по моим монетам (1h timeframe) — RSI, MACD, EMA20/EMA50, Bollinger Bands (с %B), Stochastic %K, ATR, тренд, поддержка/сопротивление + история последних 8 свечей (close, ΔPрice, RSI, MACD_hist):
${indicatorLines}

Опирайся на согласование минимум 3 индикаторов (например, RSI + MACD + EMA-кросс, либо Bollinger + Stoch + ATR), а не на один RSI. Учитывай динамику последних 8 свечей: импульс цены, изменение RSI и MACD-гистограммы, возможные дивергенции — а не только мгновенные значения.

Открытые спотовые позиции:
${spotLines}

Открытые фьючерсные позиции (USDT-perp, сторона LONG/SHORT, плечо, нереал. PnL, TP/SL и цена ликвидации указаны):
${futuresLines}

Учитывай ОБЕ части портфеля при оценке. Для фьючерсов отдельно прокомментируй сторону позиции (нет ли противоречия с трендом по индикаторам), уровень плеча и риск ликвидации, дай рекомендацию по TP/SL с учётом направления (для SHORT TP < entry, SL > entry; для LONG наоборот).

Верни строгий JSON и НИЧЕГО кроме него:
{
  "summary": "общее резюме портфеля 1-2 предложения",
  "strengths": "сильные стороны 1-2 предложения",
  "weaknesses": "слабые стороны 1-2 предложения",
  "suggestions": "общие рекомендации 1-2 предложения",
  "tpRecommendations": "общая стратегия по TP/SL 1-2 предложения",
  "positions": [
    { "symbol": "BTC", "kind": "spot" | "futures", "side": "LONG" | "SHORT", "tp": 95000, "sl": 78000, "tpReason": "почему такой TP", "slReason": "почему такой SL" }
  ]
}`;

        const t2 = Date.now();
        const aiContent = await callOpenRouter(prompt, apiKey);
        console.log(`[portfolio/analyze] openrouter in ${Date.now() - t2}ms`);

        const balance = {
            activeBalance,                              // что показываем в UI как "Активный баланс"
            wallet: rawBalance,                         // USDT walletBalance
            available: freeMargin,                      // свободно под новый ордер
            availableToWithdraw: accountSummary.available || 0,  // USDT availableToWithdraw (raw)
            unrealisedPnl: accountSummary.unrealisedPnl || 0,  // USDT unrealisedPnl (futures)
            spotValue,                                  // сумма спот-холдингов (без USDT)
            futuresNotional,                            // notional открытых фьючерсов
            futuresUnrealised,                          // суммарный PnL фьючерсов
            totalEquity: accountSummary.totalEquity || 0,
            totalAvailable: accountSummary.totalAvailableBalance || 0,
            totalWallet: accountSummary.totalWalletBalance || 0,
            ts: Date.now()
        };

        const analysis = parseAIAnalysis(aiContent);
        if (!analysis) {
            return res.status(200).json({
                success: false,
                error: 'AI вернул некорректный анализ',
                raw: aiContent,
                openPositions,
                spotPositions,
                futuresPositions: futuresOpenPositions,
                balance
            });
        }

        return res.status(200).json({
            success: true,
            analysis,
            openPositions,
            spotPositions,
            futuresPositions: futuresOpenPositions,
            balance
        });
    } catch (e) {
        console.error('portfolio/analyze error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
