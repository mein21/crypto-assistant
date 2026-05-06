// Price-shock detector / filter.
// A "shock" is a 1h candle whose absolute % change is large compared to
// the symbol's recent volatility (ATR). Shocks usually mean: liquidity
// hunt, news spike, exchange outage tail, or coordinated manipulation —
// none of which are good times to enter a structural directional trade.
//
// We expose two helpers:
//   detectPriceShock(bundle, opts) -> { isShock, changePct, atrPct,
//                                       multiplier, threshold, direction } | null
//   enforceNoShockTrade(trade, shock) -> trade  (demotes to HET if shocked)
//
// Both are pure / dependency-free so they're trivial to unit test.

const DEFAULT_ATR_MULTIPLIER = 3;   // |Δprice 1h| > 3 × ATR%
const DEFAULT_ABS_FLOOR = 0.04;     // …or absolute floor 4%, whichever is bigger

function detectPriceShock(bundle, opts = {}) {
    if (!bundle || !bundle.history || !Array.isArray(bundle.history.candles)) {
        return null;
    }
    const candles = bundle.history.candles;
    if (candles.length === 0) return null;

    const last = candles[candles.length - 1];
    const change = Number(last && last.changePct);
    if (!Number.isFinite(change)) return null;

    const atrMultiplier = Number.isFinite(opts.atrMultiplier) ? opts.atrMultiplier : DEFAULT_ATR_MULTIPLIER;
    const absFloor = Number.isFinite(opts.absFloor) ? opts.absFloor : DEFAULT_ABS_FLOOR;

    const atrPct = Number.isFinite(bundle.atrPct) ? bundle.atrPct : 0;
    const dynamicThreshold = atrMultiplier * atrPct;
    const threshold = Math.max(dynamicThreshold, absFloor);

    if (Math.abs(change) < threshold) return null;

    return {
        isShock: true,
        changePct: change,
        atrPct,
        threshold,
        multiplier: atrPct > 0 ? Math.abs(change) / atrPct : null,
        direction: change > 0 ? 'up' : 'down'
    };
}

// Compact human-readable tag we can paste straight into the AI prompt
// next to the indicator line for the shocked symbol.
function formatShockTag(shock) {
    if (!shock || !shock.isShock) return '';
    const sign = shock.changePct >= 0 ? '+' : '';
    const pct = (shock.changePct * 100).toFixed(2);
    const mult = Number.isFinite(shock.multiplier) ? `${shock.multiplier.toFixed(1)}×ATR` : 'ATR=0';
    const dir = shock.direction === 'up' ? 'вверх' : 'вниз';
    return `⚠️ ШОК ${dir}: 1ч ${sign}${pct}% (${mult}) — вероятен ложный пробой или охота за ликвидностью`;
}

// Demote LONG/SHORT to HET for shocked pairs.
function enforceNoShockTrade(trade, shock) {
    if (!trade || !shock || !shock.isShock) return trade;
    const dir = String(trade.direction || '').toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT') return trade;

    const sign = shock.changePct >= 0 ? '+' : '';
    const pct = (shock.changePct * 100).toFixed(2);
    const note = `[ценовой шок 1ч ${sign}${pct}% — пропуск входа]`;
    const reason = trade.reason ? `${trade.reason} ${note}` : note;

    return {
        ...trade,
        direction: 'HET',
        entryPrice: null,
        tp: null,
        sl: null,
        reason
    };
}

module.exports = {
    detectPriceShock,
    formatShockTag,
    enforceNoShockTrade,
    DEFAULT_ATR_MULTIPLIER,
    DEFAULT_ABS_FLOOR
};
