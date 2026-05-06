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

// Volume analysis: average volume over N candles and current bar ratio.
function computeVolumeMetrics(candles, lookback = 20) {
    if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
    const vols = candles.slice(-lookback - 1, -1).map(c => c.volume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    const currVol = candles[candles.length - 1].volume;
    const ratio = avgVol > 0 ? currVol / avgVol : 0;
    // Volume trend: compare avg of last 5 bars vs prior 5 bars
    const recent5 = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
    const prior5 = candles.slice(-10, -5).reduce((s, c) => s + c.volume, 0) / 5;
    const volTrend = prior5 > 0 ? (recent5 - prior5) / prior5 : 0;
    return { avgVol, currVol, ratio, volTrend };
}

// Find swing highs/lows for better S/R (looks left/right for pivots).
function computeSwingSR(candles, leftBars = 5, rightBars = 5) {
    if (!Array.isArray(candles) || candles.length < leftBars + rightBars + 1) return null;
    const swingHighs = [];
    const swingLows = [];
    for (let i = leftBars; i < candles.length - rightBars; i++) {
        const h = candles[i].high;
        const l = candles[i].low;
        let isHigh = true, isLow = true;
        for (let j = i - leftBars; j <= i + rightBars; j++) {
            if (j === i) continue;
            if (candles[j].high >= h) isHigh = false;
            if (candles[j].low <= l) isLow = false;
        }
        if (isHigh) swingHighs.push(h);
        if (isLow) swingLows.push(l);
    }
    const lastClose = candles[candles.length - 1].close;
    // Nearest resistance = closest swing high above price
    const resistances = swingHighs.filter(h => h > lastClose).sort((a, b) => a - b);
    // Nearest support = closest swing low below price
    const supports = swingLows.filter(l => l < lastClose).sort((a, b) => b - a);
    const support = supports.length > 0 ? supports[0] : null;
    const resistance = resistances.length > 0 ? resistances[0] : null;
    return {
        support,
        resistance,
        distanceToSupport: support != null ? (lastClose - support) / lastClose : null,
        distanceToResistance: resistance != null ? (resistance - lastClose) / lastClose : null,
        allSupports: supports.slice(0, 3),
        allResistances: resistances.slice(0, 3)
    };
}

// Pre-compute directional signal score from indicators.
// Returns { score, signals[], divergence } — no AI needed for this math.
function computeSignalScore(bundle) {
    if (!bundle) return { score: 0, signals: [], divergence: null };
    let score = 0;
    const signals = [];

    // 1) EMA cross
    if (Number.isFinite(bundle.ema20) && Number.isFinite(bundle.ema50)) {
        if (bundle.ema20 > bundle.ema50) { score += 1; signals.push('EMA20>50 (+1)'); }
        else { score -= 1; signals.push('EMA20<50 (-1)'); }
    }

    // 2) MACD histogram
    if (bundle.macd) {
        if (bundle.macd.histogram > 0) { score += 1; signals.push('MACD гист. бычья (+1)'); }
        else if (bundle.macd.histogram < 0) { score -= 1; signals.push('MACD гист. медвежья (-1)'); }
    }

    // 3) RSI
    if (Number.isFinite(bundle.rsi)) {
        if (bundle.rsi > 55) { score += 1; signals.push(`RSI=${bundle.rsi.toFixed(1)} (+1)`); }
        else if (bundle.rsi < 45) { score -= 1; signals.push(`RSI=${bundle.rsi.toFixed(1)} (-1)`); }
        else { signals.push(`RSI=${bundle.rsi.toFixed(1)} (0)`); }
    }

    // 4) Stochastic %K
    if (bundle.stoch && Number.isFinite(bundle.stoch.k)) {
        if (bundle.stoch.k > 60) { score += 1; signals.push(`Stoch %K=${bundle.stoch.k.toFixed(1)} (+1)`); }
        else if (bundle.stoch.k < 40) { score -= 1; signals.push(`Stoch %K=${bundle.stoch.k.toFixed(1)} (-1)`); }
        else { signals.push(`Stoch %K=${bundle.stoch.k.toFixed(1)} (0)`); }
    }

    // 5) Bollinger %B
    if (bundle.bb && Number.isFinite(bundle.bb.position)) {
        if (bundle.bb.position > 0.7) { score -= 1; signals.push(`%B=${bundle.bb.position.toFixed(2)} (-1 перекуп.)`); }
        else if (bundle.bb.position < 0.3) { score += 1; signals.push(`%B=${bundle.bb.position.toFixed(2)} (+1 перепрод.)`); }
        else { signals.push(`%B=${bundle.bb.position.toFixed(2)} (0)`); }
    }

    // 6) Trend
    if (bundle.trend === 'bullish') { score += 1; signals.push('тренд бычий (+1)'); }
    else if (bundle.trend === 'bearish') { score -= 1; signals.push('тренд медвежий (-1)'); }
    else { signals.push('тренд нейтральный (0)'); }

    // 7) Volume confirmation (if volume rising in trend direction)
    if (bundle.volume) {
        if (bundle.volume.ratio > 1.3 && score > 0) { score += 1; signals.push(`объём x${bundle.volume.ratio.toFixed(1)} подтверждает (+1)`); }
        else if (bundle.volume.ratio > 1.3 && score < 0) { score -= 1; signals.push(`объём x${bundle.volume.ratio.toFixed(1)} подтверждает (-1)`); }
        else if (bundle.volume.ratio < 0.7) { signals.push(`объём слабый x${bundle.volume.ratio.toFixed(1)}`); }
    }

    // Divergence detection from history
    let divergence = null;
    const h = bundle.history;
    if (h && h.candles && h.candles.length >= 4 && h.rsi && h.rsi.length >= 4) {
        const priceUp = h.candles[h.candles.length - 1].close > h.candles[0].close;
        const rsiUp = h.rsi[h.rsi.length - 1] > h.rsi[0];
        if (priceUp && !rsiUp) {
            divergence = 'медвежья (цена растёт, RSI падает)';
            score -= 1;
            signals.push('ДИВЕРГЕНЦИЯ медвежья (-1)');
        } else if (!priceUp && rsiUp) {
            divergence = 'бычья (цена падает, RSI растёт)';
            score += 1;
            signals.push('ДИВЕРГЕНЦИЯ бычья (+1)');
        }
    }

    return { score, signals, divergence };
}

// Compute the full indicator bundle from an array of candles.
// `candles` must already be sorted oldest -> newest (as fetchCandles returns).
function buildIndicatorBundle(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;

    const rsi = IndicatorService.calculateRSI(candles);
    const macd = IndicatorService.calculateMACD(candles);
    const ema20 = IndicatorService.calculateEMA(candles, 20);
    const ema50 = IndicatorService.calculateEMA(candles, 50);
    const ema200 = IndicatorService.calculateEMA(candles, 200);
    const bb = IndicatorService.calculateBollingerBands(candles);
    const stoch = IndicatorService.calculateStochastic(candles);
    const atr = IndicatorService.calculateATR(candles);
    const trend = IndicatorService.determineTrend(candles);
    const sr = IndicatorService.calculateSupportResistance(candles);
    const swingSR = computeSwingSR(candles);
    const volume = computeVolumeMetrics(candles);
    const vwap = IndicatorService.calculateVWAP(candles);

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

    const bundle = { rsi, macd, ema20, ema50, ema200, bb, stoch, atr, atrPct, trend, sr, swingSR, volume, vwap, lastClose, history };
    bundle.signalScore = computeSignalScore(bundle);
    return bundle;
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

    if (Number.isFinite(bundle.ema200)) {
        const above200 = price > bundle.ema200;
        parts.push(`EMA200=$${num(bundle.ema200, digits)} (цена ${above200 ? 'выше' : 'ниже'})`);
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

    // Use swing-based S/R if available, otherwise fall back to min/max
    const sr = bundle.swingSR || bundle.sr;
    if (sr && (sr.support != null || sr.resistance != null)) {
        const sPart = sr.support != null ? `S=$${num(sr.support, digits)}` : 'S=н/д';
        const rPart = sr.resistance != null ? `R=$${num(sr.resistance, digits)}` : 'R=н/д';
        const distS = sr.distanceToSupport != null ? `до S ${pct(sr.distanceToSupport)}` : '';
        const distR = sr.distanceToResistance != null ? `до R ${pct(sr.distanceToResistance)}` : '';
        parts.push(`${sPart}/${rPart} (${[distS, distR].filter(Boolean).join(', ')})`);
    }

    // Volume info
    if (bundle.volume) {
        const vr = bundle.volume.ratio;
        const vLabel = vr >= 1.5 ? 'повышенный' : vr >= 1.0 ? 'средний' : 'слабый';
        parts.push(`объём: x${num(vr, 1)} (${vLabel})`);
    }

    // Pre-computed score
    if (bundle.signalScore) {
        const ss = bundle.signalScore;
        const dir = ss.score > 0 ? 'LONG' : ss.score < 0 ? 'SHORT' : 'нейтр.';
        parts.push(`БАЛЛ=${ss.score > 0 ? '+' : ''}${ss.score} (${dir})`);
        if (ss.divergence) parts.push(`ДИВЕРГЕНЦИЯ: ${ss.divergence}`);
    }

    return `- ${symbol}: ${parts.join(', ')}${formatHistoryBlock(bundle)}`;
}

module.exports = {
    buildIndicatorBundle,
    formatIndicatorLine,
    computeSignalScore,
    computeSwingSR,
    computeVolumeMetrics,
    calculateRSISeries,
    calculateMACDHistSeries,
    recentCandleSummary
};
