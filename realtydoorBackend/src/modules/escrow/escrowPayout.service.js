const { gatewayRefundNote } = require('../../lib/escrowUtils');
// BE-2 — the way out of HELD_PAYOUT_FAILED. release()/refund() both still
// only accept a HELD escrow, so without this, money stuck on a failed leg
// (see escrow.service.js's release(), BE-1) had no admin-facing resolution
// at all. Kept as its own module rather than growing escrow.service.js
// further — these four actions are a distinct "fix a stuck payout" surface,
// not part of the normal release/refund lifecycle.
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { PAYABLE_PARTNER_SELECT, partnerPayoutBlocker } = require('../../lib/partnerStanding');
const {
  createPayoutContact, createPayoutFundAccount, createPayout,
  validateFundAccountOrWarn, refundPayment, rawGet, findPayoutByReference,
} = require('../../lib/razorpay');
const ledger = require('../money/ledger.service');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const logger = require('../../lib/logger');
const { refundFailure, recordRefundFailure, isClearRefusal, razorpayErrorText } = require('../../lib/refundFailure');

const IN_FLIGHT_STATUSES = ['queued', 'pending', 'processing'];
const DEAD_STATUSES = ['failed', 'rejected', 'reversed', 'cancelled'];
// A leg in one of these states still needs a person (or the lookup below) before the escrow may read RELEASED.
const NOT_PAID_STATUSES = [...DEAD_STATUSES, 'unconfirmed'];
// How long after an unanswered create call a "RazorpayX has no such payout" answer is trusted. Inside this window the
// lost request could still be on its way.
const UNCONFIRMED_SETTLE_MS = 2 * 60 * 1000;

const legFields = (leg) => (leg === 'seller'
  ? { id: 'razorpayPayoutId', status: 'sellerPayoutStatus', utr: 'sellerPayoutUtr', reason: 'sellerPayoutFailureReason', amount: 'netAmount' }
  : { id: 'razorpayPartnerPayoutId', status: 'partnerPayoutStatus', utr: 'partnerPayoutUtr', reason: 'partnerPayoutFailureReason', amount: 'partnerShareAmount' });
const referenceFor = (leg, escrowId, attempt) => `esc_${leg === 'seller' ? 's' : 'p'}_${escrowId}_a${attempt}`;

// Audit Nov 2026, F1. Records a payout that was found at RazorpayX for a leg marked "unconfirmed" (its create call got no
// answer). Stores the id and status, writes the ledger row, and puts the escrow back to RELEASED when no leg is left
// unpaid. Guarded on the leg still being "unconfirmed", so the webhook, the job and an admin cannot adopt it twice.
async function adoptPayout(escrow, leg, payout, source = 'lookup') {
  const f = legFields(leg);
  const other = legFields(leg === 'seller' ? 'partner' : 'seller');
  const dead = DEAD_STATUSES.includes(payout.status);
  const otherUnpaid = NOT_PAID_STATUSES.includes(escrow[other.status]);
  const backToReleased = escrow.status === 'HELD_PAYOUT_FAILED' && !dead && !otherUnpaid;
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrow.id, [f.status]: 'unconfirmed' },
    data: {
      [f.id]: payout.id, [f.status]: payout.status, [f.utr]: payout.utr || null,
      [f.reason]: dead ? (payout.status_details?.description || payout.status) : null,
      ...(backToReleased ? { status: 'RELEASED' } : {}),
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout found at RazorpayX (${source}): ${payout.id}, ${payout.status}`,
    },
  });
  if (claim.count === 0) return false;
  await ledger.onPayoutRecreated(escrow, {
    leg, payoutId: payout.id, status: payout.status, attempt: escrow.payoutAttempt || 0,
    amountPaise: payout.amount ?? Math.round((escrow[f.amount] || 0) * 100),
    note: `Payout found at RazorpayX after its create call got no answer: ${payout.status}`,
  });
  if (payout.status === 'processed' || dead) {
    await ledger.onPayoutStatus({ escrowId: escrow.id, payoutId: payout.id, status: payout.status, utr: payout.utr, reason: payout.status_details?.description });
  }
  await createAuditLog({
    actorRole: 'SYSTEM', action: 'ESCROW_PAYOUT_FOUND', targetType: 'EscrowTransaction', targetId: escrow.id,
    after: { leg, payoutId: payout.id, status: payout.status, source },
  }).catch((e) => logger.warn('[EscrowPayout] audit of a found payout failed', { error: e.message }));
  logger.warn('[EscrowPayout] A payout with an unknown result was found at RazorpayX', { escrowId: escrow.id, leg, payoutId: payout.id, status: payout.status, source });
  return true;
}

// Settles a leg marked "unconfirmed": asks RazorpayX for a payout with this leg's reference id.
//   found      -> adopted (see adoptPayout); returns { state: 'found', payout }
//   not there  -> the leg is marked failed ("never created"); returns { state: 'absent' }
//   too early  -> returns { state: 'wait' } and changes nothing
// Throws (from findPayoutByReference) when RazorpayX cannot be asked: the caller must then refuse to move money.
async function resolveUnconfirmedLeg(escrow, leg, source = 'lookup', now = Date.now()) {
  const f = legFields(leg);
  // Only a payout-failed escrow. A partner payout that was held back at release and then got no answer (escrow still
  // RELEASED) is finished by "Pay partner" (payDeferredPartnerCommission), which also writes the TDS entry and voucher.
  if (escrow[f.status] !== 'unconfirmed' || escrow.status !== 'HELD_PAYOUT_FAILED') return { state: 'none' };
  const payout = await findPayoutByReference(referenceFor(leg, escrow.id, escrow.payoutAttempt || 0));
  if (payout) {
    await adoptPayout(escrow, leg, payout, source);
    return { state: 'found', payout };
  }
  if (escrow.updatedAt && now - new Date(escrow.updatedAt).getTime() < UNCONFIRMED_SETTLE_MS) return { state: 'wait' };
  await prisma.escrowTransaction.updateMany({
    where: { id: escrow.id, [f.status]: 'unconfirmed' },
    data: { [f.status]: 'failed', [f.reason]: 'The payout was never created at RazorpayX (checked by reference id)' },
  });
  return { state: 'absent' };
}

// For the callers that are about to move money: every "unconfirmed" leg must be settled first.
async function settleUnconfirmedOrRefuse(escrow, legsToCheck) {
  let touched = false;
  for (const leg of legsToCheck) {
    if (escrow[legFields(leg).status] !== 'unconfirmed') continue;
    let r;
    try {
      r = await resolveUnconfirmedLeg(escrow, leg, 'admin action');
    } catch (err) {
      throw new ApiError(502, `Could not reach RazorpayX to check whether the earlier ${leg} payout exists. Nothing was changed; try again in a few minutes.`, { code: 'RAZORPAYX_ERROR' });
    }
    if (r.state === 'wait') {
      throw new ApiError(409, `The earlier ${leg} payout request got no answer from RazorpayX less than two minutes ago. Wait two minutes and try again.`, { code: 'PAYOUT_UNCONFIRMED' });
    }
    touched = true;
  }
  return touched ? prisma.escrowTransaction.findUnique({ where: { id: escrow.id } }) : escrow;
}

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
  let escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }
  // F1: a leg whose earlier create call got no answer is looked up first. If the payout exists, it is recorded and the
  // usual checks below decide (still in flight / already processed = nothing to retry).
  // Both legs, not just this one: the retry below moves the attempt number on, and an unconfirmed leg is looked up by it.
  escrow = await settleUnconfirmedOrRefuse(escrow, ['seller', 'partner']);
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(409, 'The earlier payout was found at RazorpayX and recorded. Nothing to retry.', { code: 'PAYOUT_FOUND' });
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
      ? await prisma.user.findUnique({ where: { id: lead.assignedPartnerId }, select: PAYABLE_PARTNER_SELECT })
      : null;
    const payBlocker = partnerPayoutBlocker(partner);
    if (payBlocker) throw new ApiError(400, payBlocker.message, { code: payBlocker.code });
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
    // F1: no clear refusal = the payout may exist. Mark the leg so the next action looks it up (by this attempt's
    // reference id) instead of creating another one.
    if (!isClearRefusal(err)) {
      const f = legFields(leg);
      await prisma.escrowTransaction.update({
        where: { id: escrowId },
        data: { [f.status]: 'unconfirmed', [f.reason]: 'RazorpayX did not answer the retry; the payout may or may not exist. The next retry looks it up first.' },
      });
      throw new ApiError(502, `RazorpayX did not answer the retried ${leg} payout (${razorpayErrorText(err)}). It may or may not have been created; try again in a few minutes and it will be looked up first.`, { code: 'PAYOUT_UNCONFIRMED' });
    }
    throw new ApiError(502, `RazorpayX rejected the retried ${leg} payout: ${razorpayErrorText(err)}`, { code: 'RAZORPAYX_ERROR' });
  }

  const legData = leg === 'seller'
    ? { razorpayPayoutId: payout.id, sellerPayoutStatus: payout.status, sellerPayoutFailureReason: null }
    : { razorpayPartnerPayoutId: payout.id, partnerPayoutStatus: payout.status, partnerPayoutFailureReason: null };

  // Back to RELEASED now that this leg has a payout on file again, but only when the OTHER leg is not itself failed or
  // unconfirmed (audit Nov 2026, F3: one retried leg used to hide the other leg's failure).
  const otherStatus = leg === 'seller' ? escrow.partnerPayoutStatus : escrow.sellerPayoutStatus;
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      ...legData,
      ...(NOT_PAID_STATUSES.includes(otherStatus) ? {} : { status: 'RELEASED' }),
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout retried (attempt ${nextAttempt}): ${payout.id}${note ? ` — ${note}` : ''}`,
    },
  });

  // F3: the new payout gets its own ledger row, so its webhook can settle it.
  await ledger.onPayoutRecreated(escrow, { leg, payoutId: payout.id, status: payout.status, attempt: nextAttempt, amountPaise });

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

  let escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }
  // F1: do not close the case by hand while a payout may exist that nobody has looked up. Otherwise "paid outside" could be
  // recorded on top of a payout RazorpayX did make.
  escrow = await settleUnconfirmedOrRefuse(escrow, ['seller', 'partner']);
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(409, 'An earlier payout was found at RazorpayX and recorded; this escrow is released already.', { code: 'PAYOUT_FOUND' });
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
  let escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(400, 'This escrow is not in a payout-failed state', { code: 'ESCROW_NOT_PAYOUT_FAILED' });
  }
  // F1: never refund while a payout may exist that we have no id for. Look both legs up first.
  escrow = await settleUnconfirmedOrRefuse(escrow, ['seller', 'partner']);
  if (escrow.status !== 'HELD_PAYOUT_FAILED') {
    throw new ApiError(409, 'An earlier payout was found at RazorpayX and recorded; this escrow is released, there is nothing to refund.', { code: 'PAYOUT_FOUND' });
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
    // Same handling as refund(): a low payments balance gets the "top up and try again" instruction (RAZORPAY_BALANCE_LOW),
    // anything else keeps Razorpay's own words (never "undefined": the error can be a bare {statusCode, error:{}}),
    // and the failed attempt goes into the audit trail.
    await recordRefundFailure({ escrowId, actorId: adminId, actorRole: 'ADMIN', ip, amountPaise: remainingPaise, paymentId: escrow.razorpayPaymentId, route: 'refund-remaining', err });
    throw refundFailure(err);
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
      refundReason: 'REFUND_REMAINING',
      adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}Refunded remaining ₹${(remainingPaise / 100).toFixed(2)}: ${note}`,
    },
  });

  // F4 (audit Nov 2026): this refund moved money, so it gets its ledger row and the buyer is told, like any other refund.
  await ledger.onRefund(escrow, {
    refundPaise: remainingPaise, reason: 'REFUND_REMAINING', cancellationChargePaise: 0,
    note: `Rest of the token returned after a failed payout${note ? `: ${note}` : ''}`,
  }, { refundId: refundResult.id, actor: { createdByType: 'ADMIN', createdById: adminId || null } });
  if (escrow.buyerId) {
    createNotification({
      userId: escrow.buyerId, title: 'Escrow Refunded',
      message: `₹${(remainingPaise / 100).toLocaleString('en-IN')} of your token advance has been refunded to your original payment method.${gatewayRefundNote(escrow)}`,
      type: 'ESCROW_REFUNDED', linkUrl: `/user/inquiries/${escrow.leadId}`,
    }).catch((e) => logger.warn('[EscrowPayout] buyer notice of the refund failed', { escrowId, error: e.message }));
  }

  await createAuditLog({
    adminId, action: 'ESCROW_REFUND_REMAINING', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { remainingAmount: remainingPaise / 100, refundId: refundResult.id, note }, ipAddress: ip,
  });

  return updated;
}

module.exports = { getPayouts, retryPayout, resolvePayout, refundRemaining, adoptPayout, resolveUnconfirmedLeg, referenceFor };
