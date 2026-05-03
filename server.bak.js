// Load environment variables
require('dotenv').config();

// Simple API Server for Crypto Assistant
const express = require('express');
const crypto = require('crypto');
const { TradingEngine } = require('./trading-engine');
const { BybitClient } = require('./bybit-client');
const { IndicatorService } = require('./indicators');
// Using built-in fetch (Node >=18)

const CONFIG = {
    bybit: {
        workerUrl: process.env.WORKER_URL || '',
        apiKey: process.env.BYBIT_API_KEY || '',
        apiSecret: process.env.BYBIT_API_SECRET || '',
        testnet: process.env.BYBIT_TESTNET === 'true'
    },
    trading: {
        deposit: parseFloat(process.env.TRADING_DEPOSIT) || 100,
        riskPercent: parseFloat(process.env.TRADING_RISK_PERCENT) || 4,
        minRR: parseFloat(process.env.TRADING_MIN_RR) || 1.5,
        autoTrade: process.env.TRADING_AUTO_TRADE === 'true',
        useFutures: true,
        marketType: 'auto'
    },
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        model: 'openai/gpt-oss-120b:free'
    },
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT', 'MATICUSDT'],
    futuresSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT'],
    intervals: ['15m', '1h', '4h', '1d'],
    fallbackPrices: {
        'BTCUSDT': 67500,
        'ETHUSDT': 3450,
        'SOLUSDT': 145,
        'BNBUSDT': 590,
        'ADAUSDT': 0.45,
        'DOGEUSDT': 0.12,
        'DOTUSDT': 7.2,
        'AVAXUSDT': 35,
        'LTCUSDT': 85,
        'LINKUSDT': 14,
        'MATICUSDT': 0.55
    }
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.static(__dirname));

function roundPrice(symbol, price) {
    if (!price) return price;
    const decimals = {
        'BTCUSDT': 2,
        'ETHUSDT': 2,
        'SOLUSDT': 3,
        'BNBUSDT': 2,
        'ADAUSDT': 4,
        'DOGEUSDT': 5,
        'DOTUSDT': 3,
        'AVAXUSDT': 2,
        'LTCUSDT': 2,
        'LINKUSDT': 3,
        'MATICUSDT': 4
    }[symbol] || 2;
    return parseFloat(price.toFixed(decimals));
}

const bybit = new BybitClient(CONFIG.bybit.apiKey, CONFIG.bybit.apiSecret, CONFIG.bybit.testnet);
const indicators = IndicatorService;
const { validateAIResponse } = require('./utils/validateAIResponse');
const engine = new TradingEngine(CONFIG, bybit, indicators);

app.get('/api/balance', async (req, res) => {
    try {
        const timestamp = Date.now().toString();
        const recvWindow = '5000';
        const params = 'accountType=UNIFIED';
        
        const signaturePayload = timestamp + CONFIG.bybit.apiKey + recvWindow + params;
        const signature = crypto.createHmac('sha256', CONFIG.bybit.apiSecret).update(signaturePayload).digest('hex');
        
        const options = {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': CONFIG.bybit.apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'Content-Type': 'application/json'
            }
        };
        
        const bybitUrl = 'https://api.bybit.com/v5/account/wallet-balance?' + params;
        
        // Try multiple free proxies
        const proxies = [
            { url: 'https://proxy.killcors.com?url=' + encodeURIComponent(bybitUrl), key: 'killcors' },
            { url: 'https://corsproxy.io/?url=' + encodeURIComponent(bybitUrl), key: 'corsproxy' }
        ];
        
        for (const p of proxies) {
            try {
                const resp = await fetch(p.url, options);
                const data = await resp.json();
                if (data.retCode === 0 || data.result) {
                    const coins = data.result?.list?.[0]?.coin || [];
                    const usdt = coins.find(c => c.coin === 'USDT');
                    const balance = usdt ? parseFloat(usdt.walletBalance) : 0;
                    res.json({ success: true, balance, proxy: p.key });
                    return;
                }
            } catch (e) {}
        }
        
        // All proxies failed - use client fallback
        res.json({ 
            needClientRequest: true,
            url: bybitUrl,
            timestamp,
            recvWindow,
            signature,
            apiKey: CONFIG.bybit.apiKey
        });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/analyze', async (req, res) => {
    try {
        console.log('🔍 Анализ рынка...');
        
        const prices = await engine.getPrices();
        const indicators = await engine.calculateAllIndicators(prices);
        
        // Build a detailed prompt for the AI (mirrors the Python template)
        const priceLines = Object.entries(prices)
          .map(([sym, p]) => `- ${sym}: $${p}`)
          .join('\n');
        const prompt = `Ты профессиональный криптотрейдер. Проанализируй рынок и дай точную рекомендацию в виде JSON-объекта.

Текущие цены:
${priceLines}

Технические индикаторы:
${indicators}

Верни JSON со следующими полями:
{
  "pair": "BTCUSDT",
  "direction": "LONG" | "SHORT" | "HET",
  "entryPrice": 12345.67,
  "tp": 13000.00,
  "sl": 12000.00,
  "confidence": 8,
  "reason": "Краткое обоснование"
}

ВАЖНО - ПРАВИЛА TP/SL:
- LONG: TP должен быть ВЫШЕ entryPrice, SL должен быть НИЖЕ entryPrice
- SHORT: TP должен быть НИЖЕ entryPrice, SL должен быть ВЫШЕ entryPrice
- Пример LONG: entry=$100, tp=$105, sl=$97
- Пример SHORT: entry=$100, tp=$95, sl=$103`;
        
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.openrouter.apiKey}`,
                'Content-Type': 'application/json'
            },
body: JSON.stringify({
                 model: CONFIG.openrouter.model,
                 max_tokens: 1500,
                 temperature: 0.2,
                 messages: [{ role: 'user', content: prompt }]
               })
        });
        
        console.log('✅ AI ответил');
        
const data = await response.json();
         const content = data?.choices?.[0]?.message?.content || '';
         
         // Попытка парсинга через валидатор
         const samplePrice = Object.values(prices)[0] || 0;
         const validated = validateAIResponse(content, samplePrice);
         let trade = null;
         if (validated.valid) {
           trade = {
             direction: validated.recommendation,
             entryPrice: validated.entry_price,
             tp: validated.take_profit,
             sl: validated.stop_loss,
             confidence: validated.confidence,
             reason: validated.reason,
             pair: Object.keys(prices)[0]
           };
         } else {
           // fallback: попытка вытащить JSON из ответа, как было раньше
           const jsonMatch = content.match(/\{[\s\S]*\}/);
           if (jsonMatch) {
             try {
               trade = JSON.parse(jsonMatch[0]);
             } catch (e) {
               console.log('Парсинг JSON не удался');
             }
           }
           if (!trade) {
             return res.json({ success: false, error: 'AI вернул некорректный сигнал', raw: content });
           }
         }
        
if (!trade) {
            return res.json({ 
                success: false, 
                error: 'AI не вернул корректный сигнал' 
            });
        }

        console.log('AI trade:', JSON.stringify(trade));
        
        const symbol = trade.pair.replace('/', '');
        const side = trade.direction === 'LONG' ? 'Buy' : 'Sell';
        
        const deposit = await bybit.getUSDTBalance().catch(() => CONFIG.trading.deposit);
        const riskAmount = deposit * (CONFIG.trading.riskPercent / 100);
        
        if (!trade.pair && Object.keys(prices).length > 0) {
            trade.pair = Object.keys(prices)[0];
        }
        
        if (trade.entryPrice && trade.sl) {
            const riskPerShare = Math.abs(trade.entryPrice - trade.sl);
            trade.positionSize = parseFloat((riskAmount / riskPerShare).toFixed(4));
        } else if (trade.entryPrice) {
            trade.positionSize = parseFloat((deposit * 0.1 / trade.entryPrice).toFixed(4));
        }
        
        if (!trade.pair) trade.pair = 'BTCUSDT';
        console.log('Trade to frontend:', JSON.stringify(trade));
        
        trade.riskAmount = Math.round(riskAmount * 100) / 100;
        trade.pending = true;
        trade.pendingOrder = { symbol, side, qty: trade.positionSize || 0, price: trade.entryPrice };
        if (trade.positionSize > 0) {
            console.log('✅ Ордер добавлен:', JSON.stringify(trade.pendingOrder));
        }
        
        // Реальная торговля: ограничиваем позицию 40 % от доступного баланса и выставляем TP/SL
        console.log(`DEBUG /api/analyze autoTrade: ${CONFIG.trading.autoTrade}`);
        if (CONFIG.trading.autoTrade && trade.pendingOrder) {
            try {
                const balance = await bybit.getUSDTBalance();
                // максимум 40 % от баланса для одной позиции
                const maxAllocation = balance * 0.4;
                // пересчитываем размер позиции в количествах, учитывая entryPrice
                const maxQty = Math.floor(maxAllocation / trade.entryPrice);
                const qty = Math.min(trade.positionSize, maxQty);
                if (qty <= 0) throw new Error('Недостаточно средств для размещения ордера');

                console.log('🔄 Выставление ордера (реальный аккаунт) с ограничением 40 % от баланса');
                const orderResult = await bybit.placeLimitOrder(
                    symbol,
                    side,
                    qty,
                    trade.entryPrice
                );
                // Если указаны TP/SL, сразу добавляем условные ордера
                if (trade.tp || trade.sl) {
                    const tpSlSide = side === 'Buy' ? 'Sell' : 'Buy';
                    const slParams = {
                        category: 'spot',
                        symbol,
                        side: tpSlSide,
                        orderType: 'Limit',
                        qty: String(qty),
                        price: side === 'Buy' ? String(trade.tp) : String(trade.sl),
                        timeInForce: 'GTC',
                        orderFilter: 'tpslOrder'
                    };
                    if (trade.tp) slParams.takeProfit = String(trade.tp);
                    if (trade.sl) slParams.stopLoss = String(trade.sl);
                    try {
                        await bybit.request('POST', '/v5/order/create', slParams);
                    } catch (tpSlErr) {
                        console.log('⚠️ Ошибка установки TP/SL:', tpSlErr.message);
                    }
                }
                trade.executed = true;
                trade.orderResult = orderResult;
                console.log('✅ Ордер выставлен:', orderResult.retMsg || 'OK');
            } catch (e) {
                trade.executed = false;
                trade.orderError = e.message;
                console.log('❌ Ошибка ордера:', e.message);
            }
        }
        
        res.json({ 
            success: true, 
            prices,
            indicators,
            trade,
            config: CONFIG.trading
        });
    } catch (e) {
        console.error('Error:', e);
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/execute', async (req, res) => {
    try {
        console.log('Request body:', req.body);
        const { symbol, side, qty, price, tp, sl } = req.body;
        
        console.log('Parsed:', { symbol, side, qty, price, tp, sl });
        
        if (!symbol || !side || !qty) {
            return res.json({ success: false, error: 'Missing required fields: symbol, side, qty', received: { symbol, side, qty } });
        }
        
        if (qty <= 0) {
            return res.json({ success: false, error: 'Неверное количество: ' + qty });
        }
        
        console.log(`🔄 Выставление фьючерсного ордера: ${symbol} ${side} ${qty} @ ${price || 'market'} TP: ${tp} SL: ${sl}`);
        
        let result;
        if (side === 'Buy') {
            // LONG фьючерс
            result = await bybit.placeLongFutures(
                symbol, 
                qty, 
                price ? roundPrice(symbol, price) : null, 
                tp ? roundPrice(symbol, tp) : null,
                sl ? roundPrice(symbol, sl) : null
            );
        } else {
            // SHORT фьючерс
            result = await bybit.placeShortFutures(
                symbol, 
                qty, 
                price ? roundPrice(symbol, price) : null, 
                tp ? roundPrice(symbol, tp) : null,
                sl ? roundPrice(symbol, sl) : null
            );
        }
        
        res.json({ success: true, result });
    } catch (e) {
        console.error('Execute error:', e.message);
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/execute-market', async (req, res) => {
    try {
        const { symbol, side, qty } = req.body;
        
        if (!symbol || !side || !qty) {
            return res.json({ success: false, error: 'Missing required fields: symbol, side, qty' });
        }
        
        console.log(`🔄 Выставление фьючерсного MARKET ордера: ${symbol} ${side} ${qty}`);
        
        // Для фьючерсов используем limit ордер без цены (исполнится по рыночной)
        let result;
        if (side === 'Buy') {
            result = await bybit.placeLongFutures(symbol, qty, null, null, null);
        } else {
            result = await bybit.placeShortFutures(symbol, qty, null, null, null);
        }
        
        res.json({ success: true, result });
    } catch (e) {
        console.error('Execute error:', e.message);
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/pending', (req, res) => {
    bybit.getOpenOrders().then(orders => {
        res.json({ success: true, orders: orders.result?.list || [] });
    }).catch(e => {
        res.json({ success: false, error: e.message });
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.post('/api/portfolio', async (req, res) => {
    try {
        console.log('📊 Анализ портфеля...');
        
        const prices = await engine.getPrices();
        
        const portfolioPrompt = buildPortfolioPrompt(prices);
        
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.openrouter.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: CONFIG.openrouter.model,
                max_tokens: 2500,
                messages: [{ role: 'user', content: portfolioPrompt }]
            })
        });
        
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || '';
        
        const trades = parsePortfolioTrades(content);
        
        const deposit = await bybit.getUSDTBalance().catch(() => CONFIG.trading.deposit);
        const pairCount = trades.length;
        // Выделяем процент риска от общего баланса для каждой позиции
const amountPerPair = deposit * (CONFIG.trading.riskPercent / 100);
        
        console.log(`🤖 AI выбрал ${pairCount} пар(у)`);
        console.log(`💰 Депозит: $${deposit}, на пару: $${amountPerPair.toFixed(2)}`);
        
        const results = [];
        const useFutures = CONFIG.trading.useFutures;
        
        // Получить текущие цены для расчета
        const currentPrices = await engine.getPrices();
        
        for (const trade of trades) {
// Проверка и корректировка цены (чтобы избежать «78513» vs TP 84)
            let entryPrice = trade.entryPrice;
            const currentPrice = prices[trade.symbol] || entryPrice;
            // Если цена явно не в диапазоне +-30% от текущей, берём текущую цену
            if (currentPrice && (entryPrice < currentPrice * 0.3 || entryPrice > currentPrice * 3)) {
                entryPrice = currentPrice;
            }
            // Убираем пробелы/запятые уже в extractNumber, но дополнительно проверяем неверные порядки разрядов
            // Если после исправления entryPrice всё ещё > 10 * (trade.tp || trade.sl), считаем её ошибкой и используем текущую цену
            const reference = trade.tp || trade.sl || currentPrice;
            if (reference && entryPrice > reference * 10) {
                entryPrice = currentPrice;
            }
            // Округляем до удобного формата
            if (entryPrice > 1000) entryPrice = Math.round(entryPrice);
            else if (entryPrice > 100) entryPrice = Math.round(entryPrice * 10) / 10;
            else entryPrice = Math.round(entryPrice * 100) / 100;
            
            trade.entryPrice = entryPrice;
            // ---------------------------------------------------
            // Корректировка TP/SL, если они явно в тысячных от цены входа.
            // Часто ИИ пишет цены без разделителей (например, TP 80.3 вместо 80300).
            // Если умножить TP или SL на 1000 дает значение близкое к entryPrice,
            // считаем, что это ошибка формата и поправляем.
            if (trade.tp) {
              const tpScaled = trade.tp * 1000;
              if (Math.abs(tpScaled - entryPrice) < entryPrice * 0.05) {
                trade.tp = parseFloat(tpScaled.toFixed(2));
              }
            }
            if (trade.sl) {
              const slScaled = trade.sl * 1000;
              if (Math.abs(slScaled - entryPrice) < entryPrice * 0.05) {
                trade.sl = parseFloat(slScaled.toFixed(2));
              }
            }
            // Если после попытки коррекции TP/SL всё ещё слишком далеки (разница > 5×), сбрасываем их.
            if (trade.tp && Math.abs(trade.tp - entryPrice) / entryPrice > 5) trade.tp = null;
            if (trade.sl && Math.abs(entryPrice - trade.sl) / entryPrice > 5) trade.sl = null;
            // ---------------------------------------------------

            
            // Если TP/SL отсутствуют, ставим их как небольшие отклонения от цены входа (±2 %)
            if (trade.tp == null) trade.tp = parseFloat((entryPrice * 1.02).toFixed(2));
            if (trade.sl == null) trade.sl = parseFloat((entryPrice * 0.98).toFixed(2));

            const riskAmount = amountPerPair * (CONFIG.trading.riskPercent / 100);
            const riskPerShare = Math.abs(entryPrice - trade.sl);
            
            // Минимальный ордер $5
            const minOrderValue = 5;
            let rawPosition = riskAmount / riskPerShare;
            
            // Проверка минимального значения ордера
            while (rawPosition * entryPrice < minOrderValue && rawPosition < amountPerPair / entryPrice * 2) {
                rawPosition *= 1.5;
            }
            
            // Округление в зависимости от монеты
            const coin = trade.symbol.replace('USDT', '');
            const decimals = { BTC: 4, ETH: 3, SOL: 2, BNB: 3, ADA: 0, DOGE: 0, DOT: 2, AVAX: 2, LTC: 3, LINK: 2, MATIC: 1 }[coin] || 2;
            const positionSize = parseFloat(rawPosition.toFixed(decimals));
            trade.positionSize = positionSize;
            trade.riskAmount = riskAmount;
            trade.orderId = null;
            trade.status = 'pending';
            trade.market = 'spot';
            
            const isLong = trade.direction === 'LONG';
            const useFuturesForThis = useFutures && !isLong;
            
            // Только выставляем ордера если autoTrade включен
            console.log(`DEBUG autoTrade: ${CONFIG.trading.autoTrade}`);
            if (CONFIG.trading.autoTrade) {
            try {
                let orderResult;
                
                if (useFuturesForThis) {
                    // Фьючерсы для SHORT
                    if (isLong) {
                        orderResult = await bybit.placeLongFutures(
                            trade.symbol, positionSize, trade.entryPrice, trade.tp, trade.sl
                        );
                    } else {
                        orderResult = await bybit.placeShortFutures(
                            trade.symbol, positionSize, trade.entryPrice, trade.tp, trade.sl
                        );
                    }
                    trade.market = 'futures';
                } else {
                    // Спот для LONG
                    orderResult = await bybit.placeSpotLimitOrder(
                        trade.symbol,
                        isLong ? 'Buy' : 'Sell',
                        positionSize,
                        trade.entryPrice
                    );
                    
                    // TP/SL для спота
                    if (trade.tp || trade.sl) {
                        const tpSlSide = isLong ? 'Sell' : 'Buy';
                        try {
                            // Упрощенный TP/SL
                            const slParams = {
                                category: 'spot',
                                symbol: trade.symbol,
                                side: tpSlSide,
                                orderType: 'Limit',
                                qty: String(positionSize),
                                price: isLong ? String(trade.tp) : String(trade.sl),
                                timeInForce: 'GTC',
                                orderFilter: 'tpslOrder'
                            };
                            if (trade.tp) slParams.takeProfit = String(trade.tp);
                            if (trade.sl) slParams.stopLoss = String(trade.sl);
                            
                            await bybit.request('POST', '/v5/order/create', slParams);
                        } catch (tpslErr) {
                            console.log(`⚠️ TP/SL: ${tpslErr.message}`);
                        }
                    }
                }
                
                trade.orderId = orderResult.result?.orderId || null;
                trade.status = 'executed';
                trade.orderResult = orderResult;
                
                console.log(`✅ ${trade.pair} [${trade.market}]: ${trade.direction} ${positionSize} @ $${trade.entryPrice} TP=${trade.tp} SL=${trade.sl}`);
            } catch (e) {
                trade.status = 'error';
                trade.error = e.message;
                console.log(`❌ ${trade.pair}: ${e.message}`);
            }
            } else {
                // autoTrade выключен - просто показываем рекомендации без выставления
                trade.status = 'ready';
                console.log(`📋 ${trade.pair}: готов к выставлению (autoTrade выкл)`);
            }
            
            results.push(trade);
        }
        
        res.json({
            success: true,
            pairs: results,
            totalInvested: amountPerPair * pairCount,
            totalRisk: CONFIG.trading.riskPercent,
            amountPerPair,
            deposit
        });
    } catch (e) {
        console.error('Portfolio error:', e);
        res.json({ success: false, error: e.message });
    }
});

function buildPortfolioPrompt(prices) {
    let priceInfo = 'Текущие цены:\n';
    for (const [symbol, price] of Object.entries(prices)) {
        const coin = symbol.replace('USDT', '');
        priceInfo += `- ${coin}: $${price.toLocaleString()}\n`;
    }
    
    return `${priceInfo}

ПАРАМЕТРЫ:
- Депозит: $${CONFIG.trading.deposit}
- Риск на сделку: ${CONFIG.trading.riskPercent}%
- Мин. R/R: ${CONFIG.trading.minRR}

ЗАДАЧА:
Проанализируй рынок и выбери ЛУЧШИЕ пары с уверенностью >= 80%.

Для каждой пары верни JSON:
{
    "pair": "ETH/USDT",
    "direction": "LONG",
    "confidence": 88,
    "entryPrice": 2285,
    "tp": 2365,
    "sl": 2210,
    "rr": 2.1,
    "reason": "..."
}

ВАЖНО - ПРАВИЛА TP/SL:
- LONG: TP должен быть ВЫШЕ entryPrice, SL должен быть НИЖЕ entryPrice
  - Пример: entry=$100, tp=$105, sl=$97
- SHORT: TP должен быть НИЖЕ entryPrice, SL должен быть ВЫШЕ entryPrice
  - Пример: entry=$100, tp=$95, sl=$103
- НЕ используй текущую цену как TP или SL
- R/R = (TP - entry) / (entry - SL) должен быть >= ${CONFIG.trading.minRR}

ОГРАНИЧЕНИЯ:
- Выбирай ТОЛЬКО пары с confidence >= 80
- Не выбирай больше 5 пар
- Верни массив JSON: [...]`;
}

function parsePortfolioTrades(content) {
    const trades = [];
    
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return trades;
    
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const p of parsed) {
            // Нормализуем цену (если слишком большая - делим на 1000)
            let entryPrice = p.entryPrice;
            if (entryPrice > 10000) entryPrice = entryPrice / 1000;
            
            let tp = p.tp;
            if (tp > 10000) tp = tp / 1000;
            
            let sl = p.sl;
            if (sl > 10000) sl = sl / 1000;
            
if (p.confidence >= 80 && p.rr >= CONFIG.trading.minRR) {
                trades.push({
                    pair: p.pair,
                    symbol: p.pair.replace('/', ''),
                    direction: p.direction,
                    confidence: p.confidence,
                    entryPrice: entryPrice,
                    tp: tp,
                    sl: sl,
                    rr: p.rr,
                    reason: p.reason || ''
                });


            }
        }
    } catch (e) {
        console.log('Ошибка парсинга:', e.message);
    }
    
    return trades;
}

app.get('/api/portfolio/status', async (req, res) => {
    try {
        const orders = await bybit.getOpenOrders();
        const balance = await bybit.getUSDTBalance().catch(() => CONFIG.trading.deposit);
        
        res.json({
            success: true,
            openOrders: orders.result?.list || [],
            balance,
            config: CONFIG.trading
        });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/portfolio/close', async (req, res) => {
    try {
        const orders = await bybit.getOpenOrders();
        const list = orders.result?.list || [];
        
        const results = [];
        for (const order of list) {
            try {
                const cancel = await bybit.cancelOrder(order.orderId, order.symbol);
                results.push({ symbol: order.symbol, status: 'cancelled' });
            } catch (e) {
                results.push({ symbol: order.symbol, error: e.message });
            }
        }
        
        res.json({ success: true, results });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/portfolio/analyze', async (req, res) => {
    try {
        const rawBalance = await bybit.getUSDTBalance().catch(() => CONFIG.trading.deposit);
        const coins = await bybit.getAllCoins();
        const prices = await engine.getPrices();
        
        const priceLines = Object.entries(prices)
            .map(([sym, p]) => `- ${sym}: $${p}`)
            .join('\n');
        
        const assets = Object.entries(coins)
            .filter(([coin, qty]) => qty > 0 && coin !== 'USDT')
            .map(([coin, qty]) => {
                const symbol = `${coin}USDT`;
                const currentPrice = prices[symbol] || 0;
                const value = qty * currentPrice;
                return { coin, qty, price: currentPrice, value };
            });
        
        const filteredAssets = assets.filter(a => a.value >= 1);
        
        const indicatorsMap = {};
        for (const a of filteredAssets) {
            const symbol = `${a.coin}USDT`;
            try {
                const candles = await indicators.getCandles(symbol, '1h', 100);
                if (candles.length > 0) {
                    const rsi = indicators.calculateRSI(candles);
                    const macd = indicators.calculateMACD(candles);
                    const sma20 = indicators.calculateSMA(candles, 20);
                    const sma50 = indicators.calculateSMA(candles, 50);
                    const vwap = indicators.calculateVWAP(candles);
                    indicatorsMap[a.coin] = { rsi, macd, sma20, sma50, vwap, current: a.price };
                }
            } catch (e) {
                console.log(`Error getting indicators for ${a.coin}:`, e.message);
            }
        }
        
        const openOrders = await bybit.getOpenOrders();
        const orderHistory = await bybit.getOrderHistory();
        
        const tpslOrders = (openOrders.result?.list || []).filter(o => 
            o.orderStatus === 'Untriggered' && (o.stopOrderType === 'Stop' || o.stopOrderType === 'tpslOrder')
        );
        
        const buyOrders = (orderHistory || []).filter(o => 
            o.orderStatus === 'Filled' && o.side === 'Buy'
        );
        
        const openPositions = filteredAssets.map(a => {
            const symbol = `${a.coin}USDT`;
            const tpOrder = tpslOrders.find(o => o.symbol === symbol && o.side === 'Sell');
            const currentPrice = a.price;
            
            const coinBuys = buyOrders.filter(o => o.symbol === symbol);
            let avgPrice = currentPrice;
            if (coinBuys.length > 0) {
                let totalQty = 0, totalValue = 0;
                coinBuys.forEach(o => {
                    const qty = parseFloat(o.cumExecQty);
                    const price = parseFloat(o.avgPrice);
                    totalQty += qty;
                    totalValue += qty * price;
                });
                if (totalQty > 0) avgPrice = totalValue / totalQty;
            } else if (tpOrder) {
                avgPrice = parseFloat(tpOrder.basePrice);
            }
            
            const triggerPrice = tpOrder ? parseFloat(tpOrder.triggerPrice) : null;
            
            let tp = null, sl = null, tpChance = null, slChance = null;
            if (triggerPrice) {
                if (triggerPrice > currentPrice) {
                    tp = triggerPrice;
                    tpChance = Math.max(0, 100 - ((tp - currentPrice) / currentPrice) * 100);
                } else {
                    sl = triggerPrice;
                    slChance = Math.max(0, 100 - ((currentPrice - sl) / currentPrice) * 100);
                }
            }
            
            return {
                symbol: a.coin,
                qty: a.qty,
                avgPrice: avgPrice,
                currentPrice: currentPrice,
                value: a.value,
                tp: tp,
                sl: sl,
                tpChance: tpChance !== null ? Math.round(tpChance) : null,
                slChance: slChance !== null ? Math.round(slChance) : null,
                side: 'LONG'
            };
        });
        
        const positionLines = filteredAssets.length
            ? filteredAssets.map(a => `- ${a.coin}: ${a.qty.toFixed(4)} @ $${a.price.toFixed(2)} ($${a.value.toFixed(2)})`).join('\n')
            : 'Нет активов (> $1)';
        
        const filteredValue = filteredAssets.reduce((sum, a) => sum + a.value, 0);
        const activeBalance = rawBalance + filteredValue;
        
        const positionDetails = openPositions.length
            ? openPositions.map(p => {
                let orderInfo = '';
                if (p.tp) orderInfo = `TP: $${p.tp} (шанс ${p.tpChance}%)`;
                else if (p.sl) orderInfo = `SL: $${p.sl} (шанс ${p.slChance}%)`;
                else orderInfo = 'Условный ордер: не установлен';
                return `- ${p.symbol}: ${p.qty} шт по $${p.avgPrice.toFixed(2)}, текущая $${p.currentPrice.toFixed(2)}, ${orderInfo}`;
            }).join('\n')
            : 'Нет открытых позиций';
        
        const indicatorsDetails = Object.entries(indicatorsMap)
            .map(([coin, ind]) => {
                const rsi = ind.rsi ? ind.rsi.toFixed(1) : 'н/д';
                const trend = ind.sma20 && ind.sma50 
                    ? (ind.sma20 > ind.sma50 ? 'восходящий' : 'нисходящий') 
                    : 'н/д';
                const vwapInfo = ind.vwap ? `VWAP: $${ind.vwap.toFixed(2)}` : '';
                return `- ${coin}: RSI=${rsi}, тренд=${trend} ${vwapInfo}, текущая $${ind.current.toFixed(2)}`;
            }).join('\n');
        
        const prompt = `Ты профессиональный криптотрейдер с опытом технического анализа. Проанализируй мой текущий портфель используя индикаторы. Отвечай ТОЛЬКО на русском языке.

Активный баланс (позиции > $1): $${activeBalance.toFixed(2)}

Технические индикаторы:
${indicatorsDetails}

Открытые позиции:
${positionDetails}

Верни подробный анализ в JSON:
{
  "summary": "общее резюме портфеля",
  "strengths": "сильные стороны",
  "weaknesses": "слабые стороны", 
  "suggestions": "общие рекомендации",
  "positions": [
    {
      "symbol": "SOL",
      "tp": 90.50,
      "sl": 78.00,
      "tpReason": "RSI перекуплен, VWAP resistance, цель по тренду",
      "slReason": "пробой ниже VWAP, поддержка SMA50"
    }
  ]
}`;

        const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: CONFIG.openrouter.model,
                max_tokens: 800,
                temperature: 0.2,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await aiResp.json();
        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        let analysis = null;
        if (jsonMatch) {
            try { analysis = JSON.parse(jsonMatch[0]); }
            catch (_) { analysis = { raw }; }
        } else { analysis = { raw }; }

        res.json({ success: true, analysis, openPositions });
    } catch (e) {
        console.error('Portfolio analyze error:', e);
        res.json({ success: false, error: e.message });
    }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
    console.log(`🚀 Crypto Assistant API запущен на порту ${PORT}`);
    console.log(`   http://localhost:${PORT}/api/analyze`);
    console.log(`   http://localhost:${PORT}/api/balance`);
});

module.exports = app;