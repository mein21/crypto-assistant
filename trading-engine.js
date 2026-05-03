// Trading Engine - Main Logic
const IndicatorService = require('./indicators');
const { BybitClient } = require('./bybit-client');

class TradingEngine {
    constructor(config, bybitClient, indicatorService) {
        this.config = config;
        this.bybit = bybitClient;
        this.indicators = indicatorService;
    }

    async getPrices() {
        try {
            const response = await fetch('https://api.binance.com/api/v3/ticker/price');
            const data = await response.json();
            
            const prices = {};
            for (const ticker of data) {
                if (ticker.symbol.endsWith('USDT') && 
                    this.config.symbols.includes(ticker.symbol)) {
                    prices[ticker.symbol] = parseFloat(ticker.price);
                }
            }
            return prices;
        } catch (e) {
            console.error('Error getting prices:', e);
            return {};
        }
    }

    async calculateAllIndicators(prices) {
        const allIndicators = {};
        
        for (const symbol of this.config.symbols) {
            if (!prices[symbol]) continue;
            
            try {
                const ind = await this.indicators.getAllForSymbol(symbol);
                if (ind['1h']) {
                    allIndicators[symbol] = {
                        price: prices[symbol],
                        ...ind
                    };
                }
            } catch (e) {
                console.error(`Error calculating indicators for ${symbol}:`, e);
            }
        }
        
        return allIndicators;
    }

    buildPrompt(prices, indicators) {
        let priceInfo = 'Текущие цены:\n';
        for (const [symbol, price] of Object.entries(prices)) {
            const coin = symbol.replace('USDT', '');
            priceInfo += `- ${coin}: $${price.toLocaleString()}\n`;
        }
        
        let indicatorInfo = 'Индикаторы (1h timeframe):\n';
        for (const [symbol, data] of Object.entries(indicators)) {
            const coin = symbol.replace('USDT', '');
            const ind = data['1h'] || {};
            const rsi = ind.rsi?.toFixed(0) || 'N/A';
            const trend = ind.trend || 'N/A';
            const sr = ind.sr || {};
            
            indicatorInfo += `- ${coin}: RSI=${rsi}, Trend=${trend}, ` +
                `Support=$${sr.support?.toFixed(0)}, Resistance=$${sr.resistance?.toFixed(0)}\n`;
        }
        
        const { deposit, riskPercent, minRR } = this.config.trading;
        
        return `${priceInfo}

${indicatorInfo}

ПАРАМЕТРЫ ТОРГОВЛИ:
- Депозит: ${deposit} USDT
- Риск на сделку: ${riskPercent}%
- Минимальный R/R: ${minRR}

ЗАДАЧА:
Проанализируй рынок и выбери ЛУЧШУЮ сделку учитывая:
1. Технические индикаторы (RSI, MACD, тренд, уровни)
2. Соотношение риск/прибыль
3. Уровни поддержки/сопротивления

Верни ОДНУ лучшую сделку в формате JSON:
{
    "pair": "BTC/USDT",
    "direction": "LONG" или "SHORT",
    "entryPrice": 52500,
    "tp": 53100,
    "sl": 51800,
    "positionSize": 0.1,
    "riskPercent": 2,
    "rr": 2.0,
    "confidence": 85,
    "reason": "Краткое обоснование"
}

КРИТЕРИИ ВЫБОРА:
- RSI в зоне перекупленности (LONG) или перепроданности (SHORT)
- Цена возле уровня поддержки для LONG / сопротивления для SHORT
- Четкий тренд
- R/R >= ${minRR}
- Высокая уверенность сигнала

Верни ТОЛЬКО JSON без markdown-тегов.`;
    }

    async generateStrategies(prices, indicators) {
        const prompt = this.buildPrompt(prices, indicators);
        
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.openrouter.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.config.openrouter.model,
                    max_tokens: 1500,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }
            
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || '';
            
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return parsed;
            }
            
            return null;
        } catch (e) {
            console.error('Error generating strategies:', e);
            return null;
        }
    }

    async selectBestTrade(strategies) {
        return strategies;
    }

    calculatePositionSize(trade, deposit, riskPercent) {
        const riskAmount = deposit * (riskPercent / 100);
        const riskDistance = Math.abs(trade.entryPrice - trade.sl) / trade.entryPrice;
        
        const positionSize = riskAmount / riskDistance;
        return positionSize;
    }

    async executeTrade(trade) {
        try {
            const deposit = await this.bybit.getUSDTBalance();
            console.log(`💰 Баланс USDT: ${deposit}`);
            
            const positionSize = this.calculatePositionSize(
                trade, 
                deposit || this.config.trading.deposit, 
                trade.riskPercent || this.config.trading.riskPercent
            );
            
            console.log(`📊 Размер позиции: ${positionSize.toFixed(4)} ${trade.pair.split('/')[0]}`);
            
            const symbol = trade.pair.replace('/', '');
            const side = trade.direction === 'LONG' ? 'Buy' : 'Sell';
            
            const orderResult = await this.bybit.placeLimitOrder(
                symbol,
                side,
                positionSize,
                trade.entryPrice
            );
            
            console.log(`✅ Ордер выставлен: ${orderResult.ret_msg || 'OK'}`);
            
            return {
                success: true,
                order: orderResult,
                trade,
                positionSize
            };
        } catch (e) {
            console.error('❌ Ошибка выставления ордера:', e);
            return { success: false, error: e.message };
        }
    }

    async run() {
        console.log('🚀 Запуск торгового бота...\n');
        
        console.log('1️⃣ Получение цен...');
        const prices = await this.getPrices();
        console.log(`   Найдено ${Object.keys(prices).length} пар`);
        
        console.log('2️⃣ Расчет индикаторов...');
        const indicators = await this.calculateAllIndicators(prices);
        console.log(`   Рассчитано для ${Object.keys(indicators).length} пар`);
        
        console.log('3️⃣ AI анализ...');
        const bestTrade = await this.generateStrategies(prices, indicators);
        
        if (!bestTrade) {
            console.log('❌ Не удалось получить сигнал от AI');
            return null;
        }
        
        console.log('\n🎯 ЛУЧШАЯ СДЕЛКА:');
        console.log(`   Пара: ${bestTrade.pair}`);
        console.log(`   Направление: ${bestTrade.direction}`);
        console.log(`   Вход: $${bestTrade.entryPrice}`);
        console.log(`   TP: $${bestTrade.tp}`);
        console.log(`   SL: $${bestTrade.sl}`);
        console.log(`   TP/SL: ${bestTrade.rr}R`);
        console.log(`   Уверенность: ${bestTrade.confidence}%`);
        
        if (this.config.trading.autoTrade) {
            console.log('\n4️⃣ Выставление ордера...');
            const result = await this.executeTrade(bestTrade);
            return result;
        }
        
        return { prices, indicators, bestTrade };
    }
}

module.exports = { TradingEngine };