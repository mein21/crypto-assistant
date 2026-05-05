// Estimates the probability (0..100, integer) that price will touch a target
// level (TP / SL) within `candles` candles, modelling price as a zero-drift
// random walk with per-candle volatility ≈ ATR.
//
// Standard first-passage result for a Brownian motion at a single barrier:
//     P(touch within T) ≈ 2 * (1 - Φ(d / (σ * √T)))
// where d is the absolute distance to the barrier, σ is the per-step stddev
// (≈ ATR for OHLC data), and Φ is the standard normal CDF.
//
// On 1h candles, candles=24 corresponds to a one-day horizon — a reasonable
// default for portfolio TP/SL chance estimates.

// Abramowitz & Stegun 7.1.26 erf approximation.
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
}

function normCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
}

function touchChance(price, target, atr, candles = 24) {
    if (!Number.isFinite(price) || !Number.isFinite(target)) return null;
    if (!Number.isFinite(atr) || atr <= 0) return null;
    if (price <= 0 || candles <= 0) return null;
    const distance = Math.abs(target - price);
    if (distance === 0) return 100;
    const z = distance / (atr * Math.sqrt(candles));
    const p = 2 * (1 - normCdf(z));
    return Math.max(0, Math.min(100, Math.round(p * 100)));
}

module.exports = { touchChance, erf, normCdf };
