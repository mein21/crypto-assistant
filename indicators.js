// Technical Indicator Service
const TechnicalIndicatorService = {
    async getCandles(symbol, interval, limit = 100) {
        try {
            const response = await fetch(
                `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
            );
            const klines = await response.json();
            
            return klines.map(k => ({
                time: k[0] / 1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        } catch (e) {
            console.error(`Error fetching candles for ${symbol}:`, e);
            return [];
        }
    },

    calculateRSI(candles, period = 14) {
        if (candles.length < period + 1) return null;
        
        const closes = candles.map(c => c.close);
        let gains = 0, losses = 0;
        
        for (let i = 1; i <= period; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }
        
        let avgGain = gains / period;
        let avgLoss = losses / period;
        
        for (let i = period + 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? -change : 0;
            
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
        
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    },

    calculateMACD(candles, fast = 12, slow = 26, signal = 9) {
        const closes = candles.map(c => c.close);
        if (closes.length < slow + signal) return null;
        
        const ema = (arr, period) => {
            const k = 2 / (period + 1);
            let emaArr = [arr[0]];
            for (let i = 1; i < arr.length; i++) {
                emaArr.push(arr[i] * k + emaArr[i - 1] * (1 - k));
            }
            return emaArr;
        };
        
        const fastEMA = ema(closes, fast);
        const slowEMA = ema(closes, slow);
        
        const macdLine = fastEMA.map((v, i) => v - slowEMA[i]);
        const signalLine = ema(macdLine.slice(slow), signal);
        
        const idx = macdLine.length - 1;
        return {
            macd: macdLine[idx],
            signal: signalLine[signalLine.length - 1],
            histogram: macdLine[idx] - signalLine[signalLine.length - 1]
        };
    },

    calculateEMA(candles, period) {
        const closes = candles.map(c => c.close);
        if (closes.length < period) return null;
        
        const k = 2 / (period + 1);
        let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
        
        const result = [ema];
        for (let i = period; i < closes.length; i++) {
            ema = closes[i] * k + ema * (1 - k);
            result.push(ema);
        }
        
        return result[result.length - 1];
    },

    calculateSMA(candles, period) {
        const closes = candles.map(c => c.close);
        if (closes.length < period) return null;
        
        const slice = closes.slice(-period);
        return slice.reduce((a, b) => a + b) / period;
    },

    calculateBollingerBands(candles, period = 20, stdDev = 2) {
        const closes = candles.map(c => c.close);
        if (closes.length < period) return null;
        
        const sma = closes.slice(-period).reduce((a, b) => a + b) / period;
        const variance = closes.slice(-period).reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
        const std = Math.sqrt(variance);
        
        const lastClose = closes[closes.length - 1];
        return {
            upper: sma + stdDev * std,
            middle: sma,
            lower: sma - stdDev * std,
            position: (lastClose - sma) / std
        };
    },

    calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
        if (candles.length < kPeriod) return null;
        
        const recent = candles.slice(-kPeriod);
        const highest = Math.max(...recent.map(c => c.high));
        const lowest = Math.min(...recent.map(c => c.low));
        const lastClose = recent[recent.length - 1].close;
        
        const k = ((lastClose - lowest) / (highest - lowest)) * 100;
        
        return { k, d: k };
    },

    calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return null;
        
        const tr = candles.slice(1).map((c, i) => {
            const h = c.high, l = c.low, pc = candles[i].close;
            return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        });
        
        let avgTR = tr.slice(0, period).reduce((a, b) => a + b) / period;
        
        for (let i = period; i < tr.length; i++) {
            avgTR = (avgTR * (period - 1) + tr[i]) / period;
        }
        
        return avgTR;
    },

    calculateVWAP(candles) {
        if (candles.length === 0) return null;
        
        let totalPV = 0, totalV = 0;
        for (const c of candles) {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            totalPV += typicalPrice * c.volume;
            totalV += c.volume;
        }
        
        return totalV > 0 ? totalPV / totalV : 0;
    },

    calculateVolumeProfile(candles, levels = 20) {
        const prices = candles.map(c => c.close);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const step = (max - min) / levels;
        
        const profile = {};
        for (const c of candles) {
            const level = Math.floor((c.close - min) / step);
            profile[level] = (profile[level] || 0) + c.volume;
        }
        
        return profile;
    },

    determineTrend(candles) {
        if (candles.length < 50) return 'neutral';
        
        const ema20 = this.calculateEMA(candles, 20);
        const ema50 = this.calculateEMA(candles, 50);
        
        if (ema20 && ema50) {
            if (ema20 > ema50 * 1.02) return 'bullish';
            if (ema20 < ema50 * 0.98) return 'bearish';
        }
        
        const recent = candles.slice(-10);
        const first = recent[0].close;
        const last = recent[recent.length - 1].close;
        
        if (last > first * 1.02) return 'bullish';
        if (last < first * 0.98) return 'bearish';
        
        return 'neutral';
    },

    detectConsolidation(candles, threshold = 0.02) {
        const recent = candles.slice(-20);
        const prices = recent.map(c => c.close);
        const max = Math.max(...prices);
        const min = Math.min(...prices);
        
        return (max - min) / max < threshold;
    },

    calculateSupportResistance(candles) {
        const recent = candles.slice(-50);
        const lows = recent.map(c => c.low);
        const highs = recent.map(c => c.high);
        
        const support = Math.min(...lows);
        const resistance = Math.max(...highs);
        
        const lastClose = recent[recent.length - 1].close;
        
        return {
            support,
            resistance,
            distanceToSupport: (lastClose - support) / lastClose,
            distanceToResistance: (resistance - lastClose) / lastClose
        };
    },

    async getAllForSymbol(symbol) {
        const intervals = ['15m', '1h', '4h', '1d'];
        const result = {};
        
        for (const interval of intervals) {
            const candles = await this.getCandles(symbol, interval, 100);
            if (candles.length > 0) {
                result[interval] = {
                    candles,
                    rsi: this.calculateRSI(candles),
                    macd: this.calculateMACD(candles),
                    ema20: this.calculateEMA(candles, 20),
                    ema50: this.calculateEMA(candles, 50),
                    sma20: this.calculateSMA(candles, 20),
                    bb: this.calculateBollingerBands(candles),
                    stochastic: this.calculateStochastic(candles),
                    atr: this.calculateATR(candles),
                    vwap: this.calculateVWAP(candles),
                    trend: this.determineTrend(candles),
                    consolidation: this.detectConsolidation(candles),
                    sr: this.calculateSupportResistance(candles)
                };
            }
        }
        
        return result;
    }
};

module.exports = { IndicatorService: TechnicalIndicatorService };