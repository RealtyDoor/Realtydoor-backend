const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { razorpay, rawGet } = require('../lib/razorpay');
const { confirmPayment } = require('../modules/escrow/escrow.service');
const { activateSubscription } = require('../modules/services/services.service');
const { createNotification, broadcastNotification } = require('../lib/notifications');

// BE-5 — a self-healing safety net for whatever the webhook alone might miss
// (dropped delivery, Razorpay outage, a bug that threw and — before this —
// still got acknowledged with 200). Every branch below calls the exact same
// confirm/activate paths the webhook and buyer-facing routes already use
// (confirmPayment/activateSubscription, both atomic-claim-guarded), or
// mirrors webhooks.controller.js's payout.processed/failed/reversed logic,
// so re-running this on a row that's already fine is always a safe no-op.

const STALE_PENDING_MS = 10 * 60 * 1000; // 10 minutes
const STALE_PAYOUT_MS = 60 * 60 * 1000;  // 1 hour
const IN_FLIGHT_PAYOUT_STATUSES = ['queued', 'pending', 'processing'];

async function fetchCapturedPayment(orderId) {
  const order = await razorpay.orders.fetch(orderId);
  if (order.status !== 'paid') return null;
  const payments = await razorpay.orders.fetchPayments(orderId);
  return payments.items?.find((p) => p.status === 'captured') || null;
}

async function reconcilePendingEscrows() {
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const stale = await prisma.escrowTransaction.findMany({
    where: { status: 'PAYMENT_PENDING', createdAt: { lte: cutoff } },
    select: { id: true, razorpayOrderId: true },
  });

  let healed = 0;
  for (const e of stale) {
    try {
      const captured = await fetchCapturedPayment(e.razorpayOrderId);
      if (captured) {
        await confirmPayment(e.razorpayOrderId, captured.id);
        healed++;
      }
    } catch (err) {
      logger.warn('[PaymentReconcile] Escrow order fetch failed', { escrowId: e.id, error: err.message });
    }
  }
  return healed;
}

async function reconcilePendingSubscriptions() {
  // UserSubscription has no createdAt — startDate defaults to now() at
  // creation and is only ever overwritten (to a fresh now()) once the
  // subscription actually activates, so for a still-PENDING row it's the
  // original creation time.
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const stale = await prisma.userSubscription.findMany({
    where: { paymentStatus: 'PENDING', startDate: { lte: cutoff } },
    select: { id: true, razorpayOrderId: true },
  });

  let healed = 0;
  for (const s of stale) {
    try {
      const captured = await fetchCapturedPayment(s.razorpayOrderId);
      if (captured) {
        await activateSubscription(s.razorpayOrderId, captured.id);
        healed++;
      }
    } catch (err) {
      logger.warn('[PaymentReconcile] Subscription order fetch failed', { subscriptionId: s.id, error: err.message });
    }
  }
  return healed;
}

// Mirrors webhooks.controller.js's payout.processed/payout.failed/reversed
// handlers — same per-leg status write, same HELD_PAYOUT_FAILED transition
// and admin broadcast on a failure/reversal. Kept as its own copy rather than
// a shared import: the webhook branch is keyed off a live event payload, this
// one off a polled status, and forcing both through one signature would cost
// more clarity than the ~30 duplicated lines save.
async function applyLivePayoutStatus(escrow, leg, payoutId, live) {
  if (live.status === 'processed') {
    const alreadyProcessed = leg === 'seller'
      ? escrow.sellerPayoutStatus === 'processed'
      : escrow.partnerPayoutStatus === 'processed';
    await prisma.escrowTransaction.update({
      where: { id: escrow.id },
      data: leg === 'seller'
        ? { sellerPayoutStatus: 'processed', sellerPayoutUtr: live.utr || null }
        : { partnerPayoutStatus: 'processed', partnerPayoutUtr: live.utr || null },
    });
    if (leg === 'partner' && !alreadyProcessed) {
      const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { assignedPartnerId: true } });
      if (lead?.assignedPartnerId) {
        await createNotification({
          userId: lead.assignedPartnerId,
          title: 'Payout received',
          message: `Your commission payout has been processed${live.utr ? ` (UTR ${live.utr})` : ''}.`,
          type: 'PAYOUT_PROCESSED',
          linkUrl: '/partner/finance',
        });
      }
    }
    logger.info('[PaymentReconcile] Escrow payout reconciled as processed', { payoutId, escrowId: escrow.id, leg });
    return true;
  }

  // BE-19 — same per-leg-status dedupe as webhooks.controller.js's own
  // payout.failed/reversed handler, not adminNote text matching.
  const currentLegStatus = leg === 'seller' ? escrow.sellerPayoutStatus : escrow.partnerPayoutStatus;
  if (['failed', 'reversed', 'cancelled', 'rejected'].includes(live.status)
    && ['RELEASED', 'HELD_PAYOUT_FAILED'].includes(escrow.status)
    && currentLegStatus !== live.status) {
    const reason = live.status_details?.description || live.status; // BE-20
    await prisma.escrowTransaction.update({
      where: { id: escrow.id },
      data: {
        status: 'HELD_PAYOUT_FAILED',
        adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout ${live.status} (${payoutId}): ${reason} — needs manual review (reconciled)`,
        ...(leg === 'seller'
          ? { sellerPayoutStatus: live.status, sellerPayoutFailureReason: reason }
          : { partnerPayoutStatus: live.status, partnerPayoutFailureReason: reason }),
      },
    });
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    if (admins.length > 0) {
      await broadcastNotification({
        userIds: admins.map((a) => a.id),
        title: 'Escrow payout failed',
        message: `The ${leg} payout for an escrow of ₹${escrow.amount.toLocaleString('en-IN')} ${live.status === 'reversed' ? 'was reversed' : 'failed'}: ${reason}. Needs manual review.`,
        type: 'ESCROW_PAYOUT_FAILED',
      });
    }
    logger.error('[PaymentReconcile] Escrow payout reconciled as failed/reversed', { payoutId, escrowId: escrow.id, leg, status: live.status });
    return true;
  }

  return false;
}

async function reconcileStuckPayouts() {
  // No dedicated "payout created at" timestamp exists on EscrowTransaction —
  // updatedAt is a reasonable proxy (a stuck in-flight payout's row hasn't
  // had a reason to change since release()/retryPayout wrote it), and
  // re-checking a payout that's actually still fresh just confirms its
  // in-flight status and changes nothing.
  const cutoff = new Date(Date.now() - STALE_PAYOUT_MS);
  const candidates = await prisma.escrowTransaction.findMany({
    where: {
      status: { in: ['RELEASED', 'HELD_PAYOUT_FAILED'] },
      updatedAt: { lte: cutoff },
      OR: [
        { sellerPayoutStatus: { in: IN_FLIGHT_PAYOUT_STATUSES } },
        { partnerPayoutStatus: { in: IN_FLIGHT_PAYOUT_STATUSES } },
      ],
    },
  });

  let updated = 0;
  for (const escrow of candidates) {
    const legs = [
      { leg: 'seller', payoutId: escrow.razorpayPayoutId, status: escrow.sellerPayoutStatus },
      { leg: 'partner', payoutId: escrow.razorpayPartnerPayoutId, status: escrow.partnerPayoutStatus },
    ];
    for (const l of legs) {
      if (!l.payoutId || !IN_FLIGHT_PAYOUT_STATUSES.includes(l.status)) continue;
      try {
        const live = await rawGet(`/v1/payouts/${l.payoutId}`);
        if (live.status !== l.status && await applyLivePayoutStatus(escrow, l.leg, l.payoutId, live)) {
          updated++;
        }
      } catch (err) {
        logger.warn('[PaymentReconcile] Payout status fetch failed', { escrowId: escrow.id, payoutId: l.payoutId, error: err.message });
      }
    }
  }
  return updated;
}

async function runOnce() {
  const [healedEscrows, healedSubscriptions, reconciledPayouts] = await Promise.all([
    reconcilePendingEscrows(),
    reconcilePendingSubscriptions(),
    reconcileStuckPayouts(),
  ]);
  const result = { healedEscrows, healedSubscriptions, reconciledPayouts };
  if (healedEscrows || healedSubscriptions || reconciledPayouts) {
    logger.info('[PaymentReconcile] Reconciled', result);
  }
  return result;
}

function start() {
  cron.schedule('*/15 * * * *', () => {
    runOnce().catch((err) => {
      logger.error('[PaymentReconcile] Job failed', { error: err.message, stack: err.stack });
    });
  });

  logger.info('[Jobs] Payment reconciliation job scheduled (every 15 min)');
}

module.exports = { start, runOnce };
