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
  if (leg === 'seller' && !sellerDetails) throw new ApiError(400, 'sellerDetails is required to retry the seller payout.');

  // M3 fix — the claim now runs BEFORE any fund-account/Razorpay call, and
  // is keyed on the EXACT payoutAttempt value just read, not just on
  // status. Previously the claim only bumped payoutAttempt AFTER creating
  // a (seller: brand-new, ad-hoc) fund account and was keyed on status
  // alone — two concurrent retries for the same leg both passed every
  // check above, both created their own fund account, and BOTH claims
  // then succeeded too (status stayed HELD_PAYOUT_FAILED between them;
  // nothing else in the where clause changed), so both went on to create
  // a real payout with different fund accounts/idempotency keys. Keying
  // on payoutAttempt makes the claim genuinely exclusive: the second
  // caller's updateMany matches zero rows once the first has already
  // bumped it, so only one request can ever reach the Razorpay calls below.
  //
  // Nullable field, Mongo missing-vs-null — a row that's never been
  // retried has payoutAttempt entirely ABSENT, not explicitly 0, so
  // matching `null` wouldn't match it (same gotcha fixed elsewhere this
  // session); `{ isSet: false }` is the real "still at its original,
  // never-retried attempt" condition in that case.
  const currentAttempt = escrow.payoutAttempt || 0;
  const nextAttempt = currentAttempt + 1;
  const claim = await prisma.escrowTransaction.updateMany({
    where: {
      id: escrowId, status: 'HELD_PAYOUT_FAILED',
      payoutAttempt: escrow.payoutAttempt != null ? escrow.payoutAttempt : { isSet: false },
    },
    data: { payoutAttempt: nextAttempt },
  });
  if (claim.count === 0) {
    throw new ApiError(409, 'This escrow is already being retried, or its state just changed — refresh and try again.', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }

  let fundAccountId;
  if (leg === 'seller') {
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

  const amountPaise = Math.round(amount * 100);
  // BE-1-followup — same split as release(): a short, human-readable
  // referenceId (≤40 chars) separate from the real idempotency-key input,
  // which includes fundAccountId so a retry against a CORRECTED account
  // (not just a changed amount/attempt) still gets a genuinely new key.
  const referenceId = `esc_${leg === 'seller' ? 's' : 'p'}_${escrowId}_a${nextAttempt}`;
  const idempotencyKeyInput = `${leg}:${escrowId}:${fundAccountId}:${amountPaise}:${nextAttempt}`;
  let payout;
  try {
    payout = await createPayout(fundAccountId, amountPaise, referenceId, idempotencyKeyInput);
  } catch (err) {
    throw new ApiError(502, `RazorpayX rejected the retried ${leg} payout: ${err?.error?.description || err.message || 'Unknown error'}`, { code: 'RAZORPAYX_ERROR' });
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
  // money out of the collected payment — a leg that outright failed never did.
  const legs = [];
  if (escrow.razorpayPayoutId) legs.push({ leg: 'seller', payoutId: escrow.razorpayPayoutId, storedStatus: escrow.sellerPayoutStatus, amount: escrow.netAmount || 0 });
  // Money model Rev 3: the partner commission is paid from Realtydoor's own
  // money, not out of the buyer's token, so it is not subtracted from what the
  // buyer gets back. Rows released the old way (flag absent) keep the old rule.
  if (escrow.razorpayPartnerPayoutId && !escrow.partnerPaidFromCompany) legs.push({ leg: 'partner', payoutId: escrow.razorpayPartnerPayoutId, storedStatus: escrow.partnerPayoutStatus, amount: escrow.partnerShareAmount || 0 });

  let processedPaise = 0;
  for (const l of legs) {
    let status = l.storedStatus;
    try {
      const live = await fetchPayoutStatus(l.payoutId);
      status = live.status;
    } catch (err) {
      logger.warn('[EscrowPayout] Live payout fetch failed during refund-remaining — using stored status', { payoutId: l.payoutId, error: err.message });
    }
    // H3 fix — a leg still queued/pending/processing could still land
    // AFTER this refund issues (it was previously treated the same as an
    // outright-failed leg, i.e. "not paid, safe to refund the full
    // remainder") — that's a double payment waiting to happen the moment
    // RazorpayX finishes settling it. Refuse outright instead; the FE
    // already disables this action while any leg is in flight, but the BE
    // has to enforce it too.
    if (IN_FLIGHT_STATUSES.includes(status)) {
      throw new ApiError(409, `The ${l.leg} payout is still ${status} — wait for it to settle before refunding the remainder.`, { code: 'PAYOUT_STILL_IN_FLIGHT' });
    }
    if (status === 'processed') processedPaise += Math.round(l.amount * 100);
  }

  // H3 fix — subtract whatever's already been refunded via refund.created
  // too (e.g. an earlier partial refund applied from the Razorpay
  // dashboard directly), not just processed payouts. Previously this only
  // subtracted processedPaise, so a prior partial refund's amount was
  // never accounted for and this route could refund more than was
  // actually still outstanding.
  const remainingPaise = Math.round(escrow.amount * 100) - processedPaise - (escrow.refundedAmountPaise || 0);
  if (remainingPaise <= 0) {
    throw new ApiError(409, 'Nothing left to refund — the full amount already paid out or refunded.', { code: 'NOTHING_TO_REFUND' });
  }

  // H3 fix — atomic claim BEFORE calling Razorpay, same pattern as
  // refund()/release(): previously there was no claim here at all, so a
  // double-click (or a retried request after a slow response) could pass
  // every check above twice and call refundPayment twice.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD_PAYOUT_FAILED' },
    data: { status: 'REFUNDED', refundedAt: new Date() },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });

  let refundResult;
  try {
    refundResult = await refundPayment(escrow.razorpayPaymentId, remainingPaise);
  } catch (err) {
    // Undo the claim so a retry after a transient Razorpay failure can
    // still go through, same as refund()'s own rollback.
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { status: 'HELD_PAYOUT_FAILED', refundedAt: null },
    });
    // Live-tested finding — Razorpay's own error shape here has neither
    // .error.description nor .message (a bare {statusCode, error:{}}), so
    // without a final fallback this literally printed "...failed: undefined".
    throw new ApiError(502, `RazorpayX refund failed: ${err?.error?.description || err.message || 'Unknown error'}`, { code: 'RAZORPAY_ERROR' });
  }

  // BE-6 — this refund closes out whatever was left (remainingPaise), so
  // combined with whatever was already refunded before, the escrow is
  // always FULLY refunded at this point — PARTIALLY_REFUNDED is for a
  // refund.created webhook landing a partial amount with no further action
  // taken yet, which doesn't apply to this route's own refund.
  const totalRefundedPaise = (escrow.refundedAmountPaise || 0) + remainingPaise;
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      razorpayRefundId: refundResult.id,
      refundedAmountPaise: totalRefundedPaise,
      refundIds: { push: refundResult.id },
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
