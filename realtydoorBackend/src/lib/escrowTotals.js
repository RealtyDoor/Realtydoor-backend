// One definition of "money held" and "money refunded" for every total on every screen (7 Nov 2026).
// Before this, each screen counted its own way: HELD only, or HELD plus failed payout, and a frozen or part-refunded token vanished from the
// totals or was counted at its full amount after part of it had gone back to the buyer.
//
// A token still holds the buyer's money in any of these states. For a part-refunded token only what is left is held.
const HOLDING_STATUSES = ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'];

// Rupees (escrow amount is stored in rupees, refundedAmountPaise in paise).
function refundedRupees(e) {
  if (e.status === 'REFUNDED') return e.amount || 0;
  return Math.round(((e.refundedAmountPaise || 0) / 100) * 100) / 100;
}

function heldRupees(e) {
  if (!HOLDING_STATUSES.includes(e.status)) return 0;
  return Math.max(0, Math.round(((e.amount || 0) - refundedRupees(e)) * 100) / 100);
}

const heldPaise = (e) => Math.round(heldRupees(e) * 100);

function sumHeld(rows) {
  return Math.round(rows.reduce((s, e) => s + heldRupees(e), 0) * 100) / 100;
}

// Money already returned to buyers: whole refunds plus the part-refunded share of tokens that are still open (frozen, held, part-refunded).
function sumRefunded(rows) {
  return Math.round(rows.reduce((s, e) => s + (e.status === 'REFUNDED' || HOLDING_STATUSES.includes(e.status) ? refundedRupees(e) : 0), 0) * 100) / 100;
}

module.exports = { HOLDING_STATUSES, refundedRupees, heldRupees, heldPaise, sumHeld, sumRefunded };
