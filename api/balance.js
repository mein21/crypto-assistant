// Vercel Serverless Function: GET /api/balance
// Returns the live USDT account snapshot from Bybit (via the proxy):
//   - balance / wallet         : USDT walletBalance (deposits + realised PnL)
//   - equity                   : USDT walletBalance + unrealised PnL of USDT-
//                                 margined positions — the live ticker the
//                                 widget shows.
//   - available                : free margin for placing new orders. On UTA
//                                 this is the LARGER of the per-USDT
//                                 `availableToWithdraw` and the account-level
//                                 `totalAvailableBalance` (USD), because the
//                                 first is often 0 on UTA even when the
//                                 second has plenty.
//   - availableToWithdraw      : raw per-USDT field (off-exchange withdrawal).
//   - unrealisedPnl            : nereal. PnL только в USDT-инструментах
//   - totalEquity              : total UTA equity in USD across all coins
//   - totalAvailableBalance    : raw account-level UTA free balance (USD)

const { getAccountSummary, getWorkerOverrides, setCors, errorPayload } = require('./_bybit');

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const opts = getWorkerOverrides(req);
        const summary = await getAccountSummary(opts);
        const freeMargin = Math.max(summary.available || 0, summary.totalAvailableBalance || 0);
        return res.status(200).json({
            success: true,
            // Backward-compatible field expected by older frontend code paths
            // (trade sizing uses this, so keep it pointing at walletBalance).
            balance: summary.wallet,
            wallet: summary.wallet,
            equity: summary.equity,
            available: freeMargin,
            availableToWithdraw: summary.available,
            unrealisedPnl: summary.unrealisedPnl,
            totalEquity: summary.totalEquity,
            totalAvailableBalance: summary.totalAvailableBalance,
            totalWalletBalance: summary.totalWalletBalance,
            ts: Date.now()
        });
    } catch (e) {
        console.error('balance error:', e.message);
        return res.status(200).json(errorPayload(e));
    }
};
