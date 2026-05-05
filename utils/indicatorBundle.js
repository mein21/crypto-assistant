// utils/indicatorBundle.js
// Builds a multi-indicator snapshot for a single symbol so the AI prompt
// can reason over RSI + MACD + EMA + Bollinger + Stochastic + ATR + S/R,
// not RSI alone. Returns plain numbers (or null) for safe formatting.

const { IndicatorService } = require('../indicators');

function num(v, digits = 2) {
    return Number.isFinite(v) ? v.toFixed(digits) : 'н/д';
}

function pct(v, digits = 1) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : 'н/д';
}

// Compute the full indicator bundle from an array of candles.
// `candles` must already be sorted oldest -> newest (as fetchCandles returns).
function buildIndicatorBundle(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;

    const rsi = IndicatorService.calculateRSI(candles);
    const macd = IndicatorService.calculateMACD(candles);
    const ema20 = IndicatorService.calculateEMA(candles, 20);
    const ema50 = IndicatorService.calculateEMA(candles, 50);
    const bb = IndicatorService.calculateBollingerBands(candles);
    const stoch = IndicatorService.calculateStochastic(candles);
    const atr = IndicatorService.calculateATR(candles);
    const trend = IndicatorService.determineTrend(candles);
    const sr = IndicatorService.calculateSupportResistance(candles);

    const lastClose = candles[candles.length - 1].close;
    const atrPct = (Number.isFinite(atr) && lastClose > 0) ? (atr / lastClose) : null;

    return { rsi, macd, ema20, ema50, bb, stoch, atr, atrPct, trend, sr, lastClose };
}

// Render the bundle as a compact, AI-friendly Russian line.
// `priceOverride` lets callers show the live ticker price instead of the
// last candle close (which may lag by a few seconds).
function formatIndicatorLine(symbol, bundle, priceOverride) {
    if (!bundle) return `- ${symbol}: нет данных`;

    const price = Number.isFinite(priceOverride) ? priceOverride : bundle.lastClose;
    const parts = [];

    parts.push(`цена=$${num(price, 4)}`);
    parts.push(`RSI=${num(bundle.rsi, 1)}`);

    if (bundle.macd) {
        parts.push(
            `MACD=${num(bundle.macd.macd, 4)}/sig=${num(bundle.macd.signal, 4)} ` +
            `(${bundle.macd.histogram >= 0 ? 'бычий' : 'медвежий'})`
        );
    }

    if (Number.isFinite(bundle.ema20) && Number.isFinite(bundle.ema50)) {
        const cross = bundle.ema20 > bundle.ema50 ? 'EMA20>EMA50' : 'EMA20<EMA50';
        parts.push(`EMA20=${num(bundle.ema20, 4)}, EMA50=${num(bundle.ema50, 4)} (${cross})`);
    }

    if (bundle.bb) {
        parts.push(
            `BB[low=${num(bundle.bb.lower, 4)}, mid=${num(bundle.bb.middle, 4)}, ` +
            `up=${num(bundle.bb.upper, 4)}, %B=${num(bundle.bb.position, 2)}]`
        );
    }

    if (bundle.stoch && Number.isFinite(bundle.stoch.k)) {
        parts.push(`Stoch %K=${num(bundle.stoch.k, 1)}`);
    }

    if (Number.isFinite(bundle.atrPct)) {
        parts.push(`ATR=${pct(bundle.atrPct)}`);
    }

    parts.push(`тренд=${bundle.trend || 'neutral'}`);

    if (bundle.sr) {
        parts.push(
            `S=$${num(bundle.sr.support, 4)}/R=$${num(bundle.sr.resistance, 4)} ` +
            `(до S ${pct(bundle.sr.distanceToSupport)}, до R ${pct(bundle.sr.distanceToResistance)})`
        );
    }

    return `- ${symbol}: ${parts.join(', ')}`;
}

module.exports = { buildIndicatorBundle, formatIndicatorLine };
