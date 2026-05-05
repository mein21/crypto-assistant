// Risk/Reward post-validation for AI-suggested trades.
//
// The free-tier model occasionally returns LONG/SHORT trades whose TP sits
// almost on top of entry — RR = (tp-entry)/(entry-sl) ≈ 0. After Bybit's
// round-trip taker fee (≈0.11%) those trades are guaranteed to lose, so we
// post-process the AI output and demote anything below the configured RR
// floor to direction="HET" with a clear Russian reason.
//
// User explicitly wants the floor RELAXED for high-conviction trades:
// "rr может быть меньше 1.5, если бот уверен, главное не 0".
// Mapping:
//   confidence ≥ 8 → RR ≥ 0.5
//   confidence ≥ 6 → RR ≥ 1.0
//   else            → RR ≥ 1.5
// RR ≤ 0 (TP at or beyond entry on the wrong side) is always demoted.
//
// Each tier is overridable via env: TRADING_MIN_RR_HIGH, TRADING_MIN_RR_MID,
// TRADING_MIN_RR (the lowest-confidence default — name kept for backwards
// compat with existing configs).

const MIN_RR_HIGH = parseFloat(process.env.TRADING_MIN_RR_HIGH) || 0.5;
const MIN_RR_MID  = parseFloat(process.env.TRADING_MIN_RR_MID)  || 1.0;
const MIN_RR_LOW  = parseFloat(process.env.TRADING_MIN_RR)      || 1.5;
// Confidence boundaries that pick the tier above.
const CONF_HIGH = 8;
const CONF_MID  = 6;

function computeRR(trade) {
    if (!trade) return null;
    const dir = String(trade.direction || '').toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT') return null;
    const e = Number(trade.entryPrice);
    const tp = Number(trade.tp);
    const sl = Number(trade.sl);
    if (!Number.isFinite(e) || !Number.isFinite(tp) || !Number.isFinite(sl)) return null;

    let reward, risk;
    if (dir === 'LONG') {
        reward = tp - e;
        risk = e - sl;
    } else {
        reward = e - tp;
        risk = sl - e;
    }
    if (reward <= 0 || risk <= 0) return 0;
    return reward / risk;
}

// Pick the RR floor based on the AI's stated confidence. Unknown / missing
// confidence falls back to the strictest tier so we don't accept thin RR
// without justification.
function minRRForConfidence(confidence) {
    const c = Number(confidence);
    if (!Number.isFinite(c)) return MIN_RR_LOW;
    if (c >= CONF_HIGH) return MIN_RR_HIGH;
    if (c >= CONF_MID)  return MIN_RR_MID;
    return MIN_RR_LOW;
}

// Mutate-by-copy: returns a new trade object. If RR >= the confidence-
// tiered floor the trade is returned untouched. If RR is missing (already
// HET) it's also untouched. Otherwise direction becomes HET, tp/sl are
// nulled, and the reason gets a human-readable Russian note explaining
// the demotion.
function enforceMinRR(trade) {
    const rr = computeRR(trade);
    if (rr == null) return trade;
    const minRR = minRRForConfidence(trade.confidence);
    if (rr >= minRR) return trade;

    const rrStr = rr.toFixed(2);
    const baseReason = trade.reason ? String(trade.reason).trim() : '';
    const note = `RR=${rrStr} < ${minRR} (для conf=${trade.confidence ?? '?'}), не торгуем`;
    const reason = baseReason ? `${baseReason} | ${note}` : note;

    return {
        ...trade,
        direction: 'HET',
        tp: null,
        sl: null,
        // Drop confidence — caller wanted us to skip this trade.
        confidence: typeof trade.confidence === 'number' ? Math.min(trade.confidence, 4) : null,
        reason
    };
}

module.exports = {
    computeRR,
    enforceMinRR,
    minRRForConfidence,
    MIN_RR_HIGH,
    MIN_RR_MID,
    MIN_RR_LOW
};
