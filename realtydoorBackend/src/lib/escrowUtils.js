'use strict';

// Backed by the partial unique index from scripts/createEscrowLeadUniqueIndex.js
// (name: escrow_active_lead_unique) — see escrow.service.js's createOrder for
// why this exists (the same TOCTOU pattern as isPhoneUniqueViolation in
// phoneUtils.js).
function isEscrowLeadUniqueViolation(err) {
  return err?.code === 'P2002' && err?.meta?.target === 'escrow_active_lead_unique';
}


// Does a captured payment match its order? Exactly, as always, unless Razorpay's Customer Fee Bearer is on (processing_fee_bearer = CUSTOMER):
// then our order is the token only and Razorpay adds its own charge at checkout, so the captured amount may be the token PLUS that charge. It is
// accepted only when it is the token or up to MAX_CUSTOMER_FEE_PCT above it (Razorpay's highest rate is 3.54%, 3.5% for international Amex); lower is
// always refused, and so is anything much higher, which could be a wrong or tampered payment. Whether Razorpay reports the token or the total as the
// payment amount is not in its public docs; both are accepted so a real payment is never lost, and the first Test Mode payment must confirm it.
const MAX_CUSTOMER_FEE_PCT = 6;
function paymentMatchesOrder({ paidPaise, expectedPaise, currency, bearer }) {
  if (currency !== 'INR' || !Number.isInteger(paidPaise) || !Number.isInteger(expectedPaise)) return false;
  if (bearer !== 'CUSTOMER') return paidPaise === expectedPaise;
  return paidPaise >= expectedPaise && paidPaise <= expectedPaise + Math.ceil((expectedPaise * MAX_CUSTOMER_FEE_PCT) / 100);
}

// What every refund notice adds when the payment had no processing fee of ours (Razorpay's Customer Fee Bearer, permanent since
// 20-21 Nov 2026): Razorpay's own charge is not returned (its amount when known; nothing when Razorpay took none) and how to raise
// a request (owner: a mistake of ours is settled offline through a request). An older payment with our own fee gets ''.
function gatewayRefundNote(escrow) {
  if (escrow?.processingFeePaise > 0) return '';
  const charge = escrow?.gatewayChargePaise;
  const request = ' If you think we made a mistake, raise a request from your account.';
  if (charge === 0) return request;
  const amt = Number.isInteger(charge) && charge > 0 ? ` of ₹${(charge / 100).toLocaleString('en-IN')}` : '';
  return ` Razorpay's payment-gateway charge${amt} is not returned: Razorpay keeps it.${request}`;
}

module.exports = {
  gatewayRefundNote,
  paymentMatchesOrder, MAX_CUSTOMER_FEE_PCT, isEscrowLeadUniqueViolation };
