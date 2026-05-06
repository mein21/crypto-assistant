// Crypto Strategy AI - Professional Trading Bot with Auto-Trading
require('dotenv').config();
const { BybitClient } = require('./bybit-client');
const { IndicatorService } = require('./indicators');
const { TradingEngine } = require('./trading-engine');

const CONFIG = {
    bybit: {
        apiKey: process.env.BYBIT_API_KEY || '',
        apiSecret: process.env.BYBIT_API_SECRET || '',
        testnet: process.env.BYBIT_TESTNET === 'true'
    },
    trading: {
        deposit: parseFloat(process.env.TRADING_DEPOSIT) || 100,
        riskPercent: parseFloat(process.env.TRADING_RISK_PERCENT) || 4,
        minRR: parseFloat(process.env.TRADING_MIN_RR) || 1.5,
        autoTrade: process.env.TRADING_AUTO_TRADE === 'true'
    },
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        model: process.env.OPENROUTER_MODEL || 'tencent/hy3-preview:free'
    },
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT', 'LTCUSDT', 'LINKUSDT', 'MATICUSDT'],
    intervals: ['15m', '1h', '4h', '1d']
};

class CryptoAssistant {
    constructor() {
        this.bybit = new BybitClient(CONFIG.bybit.apiKey, CONFIG.bybit.apiSecret, CONFIG.bybit.testnet);
        this.indicators = new IndicatorService();
        this.engine = new TradingEngine(CONFIG, this.bybit, this.indicators);
    }

    async analyze() {
        console.log('🔍 Получение цен и индикаторов...');
        const prices = await this.engine.getPrices();
        const indicators = await this.engine.calculateAllIndicators(prices);
        
        console.log('🤖 AI анализ рынка...');
        const strategies = await this.engine.generateStrategies(prices, indicators);
        
        console.log('🎯 Выбор лучшей сделки...');
        const bestTrade = await this.engine.selectBestTrade(strategies);
        
        if (bestTrade && CONFIG.trading.autoTrade) {
            console.log('⚡ Автоматическое выставление ордера...');
            const result = await this.engine.executeTrade(bestTrade);
            return result;
        }
        
        return { strategies, bestTrade };
    }
}

if (require.main === module) {
    const assistant = new CryptoAssistant();
    assistant.analyze().then(console.log).catch(console.error);
}

module.exports = { CryptoAssistant, CONFIG };