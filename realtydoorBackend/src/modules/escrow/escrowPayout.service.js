// BE-2 — the way out of HELD_PAYOUT_FAILED. release()/refund() both still
// only accept a HELD escrow, so without this, money stuck on a failed leg
// (see escrow.service.js's release(), BE-1) had no admin-facing resolution
// at all. Kept as its own module rather than growing escrow.service.js
// further — these four actions are a distinct "fix a stuck payout" surface,
// not part of the normal release/refund lifecycle.
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const {
  createPayoutContact, createPayoutFundAccount, createPayout,
  validateFundAccountOrWarn, refundPayment, rawGet,
} = require('../../lib/razorpay');
const { createAuditLog } = require('../../lib/auditLog');
const logger = require('../../lib/logger');

const IN_FLIGHT_STATUSES = ['queued', 'pending', 'processing'];

async function fetchPayoutStatus(payoutId) {
  return rawGet(`/v1/payouts/${payoutId}`);
}

async function getPayouts(escrowId) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');

  const legs = [];
  if (escrow.razorpayPayoutId) {
    legs.push({ leg: 'seller', payoutId: escrow.razorpayPayoutId, storedStatus: escrow.sellerPayoutStatus, storedUtr: escrow.sellerPayoutUtr, amount: escrow.netAmount });
  }
  if (escrow.razorpayPartnerPayoutId) {
    legs.push({ leg: 'partner', payoutId: escrow.razorpayPartnerPayoutId, storedStatus: escrow.partnerPayoutStatus, storedUtr: escrow.partnerPayoutUtr, amount: escrow.partnerShareAmount });
  }

  return Promise.all(legs.map(async (l) => {
    try {
      const live = await fetchPayoutStatus(l.payoutId);
      return {
        leg: l.leg, payoutId: l.payoutId, amount: live.amount != null ? live.amount / 100 : l.amount,
        status: live.status, utr: live.utr || l.storedUtr || null,
        failureReason: live.status_details?.description || null,
        attempt: escrow.payoutAttempt || 0,
        createdAt: live.created_at ? new Date(live.created_at * 1000) : null,
      };
    } catch (err) {
      logger.warn('[EscrowPayout] Live payout fetch failed — falling back to stored status', { payoutId: l.payoutId, error: err.message });
      return {
        leg: l.leg, payoutId: l.payoutId, amount: l.amount, status: l.storedStatus,
        utr: l.storedUtr, failureReason: null, attempt: escrow.payoutAttempt || 0, createdAt: null,
      };
    }
  }));
}

async function retryPayout(escrowId, { leg, sellerDetails, note }, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }

  const existingPayoutId = leg === 'seller' ? escrow.razorpayPayoutId : escrow.razorpayPartnerPayoutId;
  if (existingPayoutId) {
    let live;
    try {
      live = await fetchPayoutStatus(existingPayoutId);
    } catch (err) {
      throw new ApiError(502, 'Could not reach RazorpayX to check the existing payout before retrying', { code: 'RAZORPAYX_ERROR' });
    }
    if (IN_FLIGHT_STATUSES.includes(live.status)) {
      throw new ApiError(409, `The previous ${leg} payout is still ${live.status} — wait for it to settle before retrying.`, { code: 'PAYOUT_STILL_IN_FLIGHT' });
    }
    if (live.status === 'processed') {
      throw new ApiError(409, `The previous ${leg} payout already processed — nothing to retry.`, { code: 'PAYOUT_ALREADY_PROCESSED' });
    }
  }

  const amount = leg === 'seller' ? escrow.netAmount : escrow.partnerShareAmount;
  if (!amount) {
    throw new ApiError(400, `No ${leg} amount is on file for this escrow — nothing to retry.`, { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }

  let fundAccountId;
  if (leg === 'seller') {
    if (!sellerDetails) throw new ApiError(400, 'sellerDetails is required to retry the seller payout.');
    const contact = await createPayoutContact(sellerDetails.name, sellerDetails.email, sellerDetails.phone);
    const fundAccount = await createPayoutFundAccount(contact.id, sellerDetails.name, sellerDetails.ifsc, sellerDetails.accountNumber);
    await validateFundAccountOrWarn(fundAccount.id, 'seller');
    fundAccountId = fundAccount.id;
  } else {
    // Same resolution as release()'s own partner leg — the partner's
    // onboarded, already penny-drop-checked RazorpayX fund account.
    const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { assignedPartnerId: true } });
    const partner = lead?.assignedPartnerId
      ? await prisma.user.findUnique({ where: { id: lead.assignedPartnerId }, select: { razorpayFundAccountId: true, payoutAccountStatus: true } })
      : null;
    if (!partner?.razorpayFundAccountId || partner.payoutAccountStatus !== 'ACTIVE') {
      throw new ApiError(400, "The assigned partner's payout account is not active — resolve that before retrying their share.", { code: 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE' });
    }
    fundAccountId = partner.razorpayFundAccountId;
  }

  // Atomic bump of payoutAttempt, double-click safe — also what makes the
  // idempotency key below a genuinely new one, not a dedupe against the
  // failed attempt (see escrow.service.js's release(), BE-1).
  const nextAttempt = (escrow.payoutAttempt || 0) + 1;
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD_PAYOUT_FAILED' },
    data: { payoutAttempt: nextAttempt },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });

  const amountPaise = Math.round(amount * 100);
  const referenceId = `escrow_${leg}_${escrowId}_${amountPaise}_a${nextAttempt}`;
  let payout;
  try {
    payout = await createPayout(fundAccountId, amountPaise, referenceId);
  } catch (err) {
    throw new ApiError(502, `RazorpayX rejected the retried ${leg} payout: ${err?.error?.description || err.message}`, { code: 'RAZORPAYX_ERROR' });
  }

  const legData = leg === 'seller'
    ? { razorpayPayoutId: payout.id, sellerPayoutStatus: payout.status }
    : { razorpayPartnerPayoutId: payout.id, partnerPayoutStatus: payout.status };

  // Back to RELEASED now that this leg has a payout on file again — if the
  // OTHER leg independently fails later, the existing payout.failed/reversed
  // webhook already re-flags ANY RELEASED escrow back to HELD_PAYOUT_FAILED,
  // so this is self-healing either way.
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      ...legData,
      status: 'RELEASED',
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout retried (attempt ${nextAttempt}): ${payout.id}${note ? ` — ${note}` : ''}`,
    },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_PAYOUT_RETRIED', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { leg, payoutId: payout.id, attempt: nextAttempt, note }, ipAddress: ip,
  });

  return updated;
}

async function resolvePayout(escrowId, { resolution, note }, adminId, ip) {
  if (!['PAID_OUTSIDE', 'PAYOUT_CONFIRMED'].includes(resolution)) {
    throw new ApiError(400, "resolution must be 'PAID_OUTSIDE' or 'PAYOUT_CONFIRMED'");
  }
  if (!note || note.trim().length < 5 || note.length > 500) {
    throw new ApiError(400, 'A note of 5-500 characters is required', { code: 'NOTE_REQUIRED' });
  }

  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }

  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD_PAYOUT_FAILED' },
    data: {
      status: 'RELEASED',
      resolvedAt: new Date(),
      resolvedByAdminId: adminId,
      resolution,
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}Resolved (${resolution}): ${note}`,
    },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });

  await createAuditLog({
    adminId, action: 'ESCROW_PAYOUT_RESOLVED', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { resolution, note }, ipAddress: ip,
  });

  return prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
}

async function refundRemaining(escrowId, note, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');

  // Only a leg that actually reached RazorpayX's "processed" state took real
  // money out of the collected payment — queued/pending/processing could
  // still land, and a leg that outright failed never did.
  const legs = [];
  if (escrow.razorpayPayoutId) legs.push({ payoutId: escrow.razorpayPayoutId, storedStatus: escrow.sellerPayoutStatus, amount: escrow.netAmount || 0 });
  if (escrow.razorpayPartnerPayoutId) legs.push({ payoutId: escrow.razorpayPartnerPayoutId, storedStatus: escrow.partnerPayoutStatus, amount: escrow.partnerShareAmount || 0 });

  let processedPaise = 0;
  for (const l of legs) {
    let status = l.storedStatus;
    try {
      const live = await fetchPayoutStatus(l.payoutId);
      status = live.status;
    } catch (err) {
      logger.warn('[EscrowPayout] Live payout fetch failed during refund-remaining — using stored status', { payoutId: l.payoutId, error: err.message });
    }
    if (status === 'processed') processedPaise += Math.round(l.amount * 100);
  }

  const remainingPaise = Math.round(escrow.amount * 100) - processedPaise;
  if (remainingPaise <= 0) {
    throw new ApiError(409, 'Nothing left to refund — the full amount already paid out.', { code: 'NOTHING_TO_REFUND' });
  }

  let refundResult;
  try {
    refundResult = await refundPayment(escrow.razorpayPaymentId, remainingPaise);
  } catch (err) {
    throw new ApiError(502, `RazorpayX refund failed: ${err?.error?.description || err.message}`, { code: 'RAZORPAY_ERROR' });
  }

  // Tier-3 (BE-6) distinguishes a partial refund (PARTIALLY_REFUNDED) from a
  // full one — this route is new, so REFUNDED unconditionally is correct for
  // now; BE-6 revisits this once that status exists.
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      status: 'REFUNDED',
      razorpayRefundId: refundResult.id,
      refundedAt: new Date(),
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}Refunded remaining ₹${(remainingPaise / 100).toFixed(2)}: ${note}`,
    },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_REFUND_REMAINING', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { remainingAmount: remainingPaise / 100, refundId: refundResult.id, note }, ipAddress: ip,
  });

  return updated;
}

module.exports = { getPayouts, retryPayout, resolvePayout, refundRemaining };
