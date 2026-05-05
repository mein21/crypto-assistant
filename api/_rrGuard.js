// Risk/Reward post-validation for AI-suggested trades.
//
// The free-tier model occasionally returns LONG/SHORT trades whose TP sits
// almost on top of entry — RR = (tp-entry)/(entry-sl) ≈ 0. After Bybit's
// round-trip taker fee (≈0.11%) those trades are guaranteed to lose, so we
// post-process the AI output and demote anything with RR below the
// configured floor to direction="HET" with a clear reason.
//
// Threshold defaults to 1.5 — matches the TRADING_MIN_RR env var used
// elsewhere in the project.

const DEFAULT_MIN_RR = parseFloat(process.env.TRADING_MIN_RR) || 1.5;

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

// Mutate-by-copy: returns a new trade object. If RR >= minRR the trade is
// returned untouched. If RR is missing (already HET) it's also untouched.
// Otherwise direction becomes HET, tp/sl are nulled, and the reason gets a
// human-readable note in Russian.
function enforceMinRR(trade, minRR = DEFAULT_MIN_RR) {
    const rr = computeRR(trade);
    if (rr == null) return trade;
    if (rr >= minRR) return trade;

    const rrStr = rr.toFixed(2);
    const baseReason = trade.reason ? String(trade.reason).trim() : '';
    const note = `RR=${rrStr} < ${minRR}, не торгуем`;
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
    DEFAULT_MIN_RR
};
