// utils/indicatorBundle.js
// Builds a multi-indicator snapshot for a single symbol so the AI prompt
// can reason over RSI + MACD + EMA + Bollinger + Stochastic + ATR + S/R
// AND see how price + indicators evolved over the last few candles
// (so it can detect divergence, momentum shifts, etc.) — not just the
// last instantaneous value.

const { IndicatorService } = require('../indicators');

const HISTORY_POINTS = 8; // recent 1h points shown to the AI

function num(v, digits = 2) {
    return Number.isFinite(v) ? v.toFixed(digits) : 'н/д';
}

function pct(v, digits = 1) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : 'н/д';
}

function smartPriceDigits(price) {
    if (!Number.isFinite(price) || price === 0) return 4;
    const abs = Math.abs(price);
    if (abs >= 1000) return 2;
    if (abs >= 1) return 4;
    if (abs >= 0.01) return 5;
    return 6;
}

// Wilder-style RSI computed at every step from `period+1` onwards.
// Returns an array of RSI values aligned with `candles[period..]`.
function calculateRSISeries(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return [];

    const closes = candles.map(c => c.close);
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    const rsiFromAvgs = (g, l) => {
        if (g === 0 && l === 0) return 50;
        if (l === 0) return 100;
        if (g === 0) return 0;
        return 100 - 100 / (1 + g / l);
    };

    const series = [];
    series.push(rsiFromAvgs(avgGain, avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        series.push(rsiFromAvgs(avgGain, avgLoss));
    }
    return series;
}

function ema(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) {
        out.push(values[i] * k + out[i - 1] * (1 - k));
    }
    return out;
}

// MACD histogram series: macd - signal at each step where both are defined.
function calculateMACDHistSeries(candles, fast = 12, slow = 26, signal = 9) {
    if (!Array.isArray(candles) || candles.length < slow + signal) return [];

    const closes = candles.map(c => c.close);
    const fastEMA = ema(closes, fast);
    const slowEMA = ema(closes, slow);

    // MACD line is meaningful from index `slow-1` onwards.
    const macdLine = [];
    for (let i = slow - 1; i < closes.length; i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }

    const signalLine = ema(macdLine, signal);

    // Histogram = macd - signal, both arrays are the same length here.
    const hist = macdLine.map((v, i) => v - signalLine[i]);
    return hist;
}

// Last `count` candles with close + percent change vs the previous close.
function recentCandleSummary(candles, count = HISTORY_POINTS) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const start = Math.max(1, candles.length - count);
    const out = [];
    for (let i = start; i < candles.length; i++) {
        const prev = candles[i - 1].close;
        const close = candles[i].close;
        const changePct = prev > 0 ? (close - prev) / prev : null;
        out.push({ close, changePct, time: candles[i].time });
    }
    return out;
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

    const rsiSeriesAll = calculateRSISeries(candles);
    const macdHistAll = calculateMACDHistSeries(candles);
    const recent = recentCandleSummary(candles, HISTORY_POINTS);

    const history = {
        count: recent.length,
        candles: recent,
        rsi: rsiSeriesAll.slice(-recent.length),
        macdHist: macdHistAll.slice(-recent.length)
    };

    return { rsi, macd, ema20, ema50, bb, stoch, atr, atrPct, trend, sr, lastClose, history };
}

function formatHistoryBlock(bundle) {
    const h = bundle && bundle.history;
    if (!h || !h.candles || h.candles.length === 0) return '';

    const digits = smartPriceDigits(bundle.lastClose);

    const closes = h.candles.map(c => num(c.close, digits)).join(', ');
    const changes = h.candles
        .map(c => Number.isFinite(c.changePct) ? `${c.changePct >= 0 ? '+' : ''}${(c.changePct * 100).toFixed(2)}%` : 'н/д')
        .join(', ');
    const rsiStr = h.rsi.length
        ? h.rsi.map(v => num(v, 1)).join(', ')
        : 'н/д';
    const macdStr = h.macdHist.length
        ? h.macdHist.map(v => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(4)}` : 'н/д').join(', ')
        : 'н/д';

    return (
        `\n  · история (1h, последние ${h.candles.length}):` +
        ` close=[${closes}]; ΔPрice=[${changes}]; RSI=[${rsiStr}]; MACD_hist=[${macdStr}]`
    );
}

// Render the bundle as a compact, AI-friendly Russian line.
// `priceOverride` lets callers show the live ticker price instead of the
// last candle close (which may lag by a few seconds).
function formatIndicatorLine(symbol, bundle, priceOverride) {
    if (!bundle) return `- ${symbol}: нет данных`;

    const price = Number.isFinite(priceOverride) ? priceOverride : bundle.lastClose;
    const digits = smartPriceDigits(price);
    const parts = [];

    parts.push(`цена=$${num(price, digits)}`);
    parts.push(`RSI=${num(bundle.rsi, 1)}`);

    if (bundle.macd) {
        parts.push(
            `MACD=${num(bundle.macd.macd, 4)}/sig=${num(bundle.macd.signal, 4)} ` +
            `(${bundle.macd.histogram >= 0 ? 'бычий' : 'медвежий'})`
        );
    }

    if (Number.isFinite(bundle.ema20) && Number.isFinite(bundle.ema50)) {
        const cross = bundle.ema20 > bundle.ema50 ? 'EMA20>EMA50' : 'EMA20<EMA50';
        parts.push(`EMA20=${num(bundle.ema20, digits)}, EMA50=${num(bundle.ema50, digits)} (${cross})`);
    }

    if (bundle.bb) {
        parts.push(
            `BB[low=${num(bundle.bb.lower, digits)}, mid=${num(bundle.bb.middle, digits)}, ` +
            `up=${num(bundle.bb.upper, digits)}, %B=${num(bundle.bb.position, 2)}]`
        );
    }

    if (bundle.stoch && Number.isFinite(bundle.stoch.k)) {
        const dPart = Number.isFinite(bundle.stoch.d) ? `/%D=${num(bundle.stoch.d, 1)}` : '';
        parts.push(`Stoch %K=${num(bundle.stoch.k, 1)}${dPart}`);
    }

    if (Number.isFinite(bundle.atrPct)) {
        parts.push(`ATR=${pct(bundle.atrPct)}`);
    }

    parts.push(`тренд=${bundle.trend || 'neutral'}`);

    if (bundle.sr) {
        parts.push(
            `S=$${num(bundle.sr.support, digits)}/R=$${num(bundle.sr.resistance, digits)} ` +
            `(до S ${pct(bundle.sr.distanceToSupport)}, до R ${pct(bundle.sr.distanceToResistance)})`
        );
    }

    return `- ${symbol}: ${parts.join(', ')}${formatHistoryBlock(bundle)}`;
}

module.exports = {
    buildIndicatorBundle,
    formatIndicatorLine,
    calculateRSISeries,
    calculateMACDHistSeries,
    recentCandleSummary
};
