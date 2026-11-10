const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { razorpay, rawGet } = require('../lib/razorpay');
const { confirmPayment } = require('../modules/escrow/escrow.service');
const { activateSubscription } = require('../modules/services/services.service');
const { createNotification, broadcastNotification, notifyAdmins } = require('../lib/notifications');
const { notifyUser } = require('../lib/wati');
const { onPayoutFailed } = require('../lib/payoutAlerts');
const ledger = require('../modules/money/ledger.service');
const { createAuditLog } = require('../lib/auditLog');
const { alertStaff } = require('../lib/staffAlerts');

// BE-5 — a self-healing safety net for whatever the webhook alone might miss
// (dropped delivery, Razorpay outage, a bug that threw and — before this —
// still got acknowledged with 200). Every branch below calls the exact same
// confirm/activate paths the webhook and buyer-facing routes already use
// (confirmPayment/activateSubscription, both atomic-claim-guarded), or
// mirrors webhooks.controller.js's payout.processed/failed/reversed logic,
// so re-running this on a row that's already fine is always a safe no-op.

const STALE_PENDING_MS = 10 * 60 * 1000; // 10 minutes
// L2 fix — without an upper bound, a row that never gets paid (an
// abandoned Checkout, a buyer who gave up) got rescanned — one Razorpay
// orders.fetch call, every 15 minutes, forever. 48h is well past any
// realistic "buyer came back and finished paying" window; anything still
// PENDING past that is for admin to chase manually, not this job.
const RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
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
  const maxAgeCutoff = new Date(Date.now() - RECONCILE_MAX_AGE_MS);
  const stale = await prisma.escrowTransaction.findMany({
    // FAILED too: earlier failure notices closed orders that could still be paid on a retry (see confirmPayment).
    where: { status: { in: ['PAYMENT_PENDING', 'FAILED'] }, createdAt: { lte: cutoff, gte: maxAgeCutoff } },
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
  const maxAgeCutoff = new Date(Date.now() - RECONCILE_MAX_AGE_MS);
  const stale = await prisma.userSubscription.findMany({
    where: { paymentStatus: 'PENDING', startDate: { lte: cutoff, gte: maxAgeCutoff } },
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
    // Audit Nov 2026, F27: the ledger gets its PAID line here too, same as from the webhook (same key, so never twice).
    await ledger.onPayoutStatus({ escrowId: escrow.id, payoutId, status: 'processed', utr: live.utr });
    if (leg === 'partner' && live.utr) {
      await prisma.commissionVoucher.updateMany({ where: { escrowId: escrow.id }, data: { utr: live.utr, payoutId } }).catch(() => {});
    }
    if (leg === 'partner' && !alreadyProcessed) {
      const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { assignedPartnerId: true, refCode: true } });
      if (lead?.assignedPartnerId) {
        await createNotification({
          userId: lead.assignedPartnerId,
          title: 'Payout received',
          message: `Your commission payout has been processed${live.utr ? ` (UTR ${live.utr})` : ''}.`,
          type: 'PAYOUT_PROCESSED',
          linkUrl: '/partners/finance',
        });
        notifyUser(lead.assignedPartnerId, 'escrow_released', {
          name: '$userName', amount: Math.round((live.amount || 0) / 100).toLocaleString('en-IN'), lead_ref: lead.refCode || 'your lead',
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
    onPayoutFailed({ escrow, leg, status: live.status, reason });
    await ledger.onPayoutStatus({ escrowId: escrow.id, payoutId, status: live.status, reason });
    await createAuditLog({
      actorRole: 'SYSTEM', action: live.status === 'reversed' ? 'PAYOUT_REVERSED' : 'PAYOUT_FAILED',
      targetType: 'EscrowTransaction', targetId: escrow.id,
      before: { [`${leg}PayoutStatus`]: currentLegStatus ?? null }, after: { [`${leg}PayoutStatus`]: live.status, payoutId }, reason,
    }).catch((e) => logger.warn('[PaymentReconcile] audit of payout failure failed', { error: e.message }));
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

// Audit Nov 2026, F1: a payout leg marked "unconfirmed" (its create call got no answer) is looked up at RazorpayX by the
// reference id we sent. Found: recorded, and the escrow goes back to RELEASED if nothing else is wrong. Not there: the
// leg is marked failed and admins are told to retry or refund. RazorpayX unreachable: left alone until the next run.
async function reconcileUnconfirmedPayouts() {
  const { resolveUnconfirmedLeg } = require('../modules/escrow/escrowPayout.service');
  const rows = await prisma.escrowTransaction.findMany({
    where: { status: 'HELD_PAYOUT_FAILED', OR: [{ sellerPayoutStatus: 'unconfirmed' }, { partnerPayoutStatus: 'unconfirmed' }] },
  });
  let settled = 0;
  for (const row of rows) {
    for (const leg of ['seller', 'partner']) {
      try {
        // Re-read: settling the first leg changes the row the second leg is judged against.
        const escrow = await prisma.escrowTransaction.findUnique({ where: { id: row.id } });
        const r = await resolveUnconfirmedLeg(escrow, leg, 'reconcile job');
        if (r.state === 'found' || r.state === 'absent') settled++;
        if (r.state === 'absent') {
          await notifyAdmins({
            title: 'Payout was not created',
            message: `The ${leg} payout for an escrow of ₹${escrow.amount.toLocaleString('en-IN')} got no answer from RazorpayX and was checked: it does not exist. Retry the payout or refund the token from Escrow.`,
            type: 'ESCROW_PAYOUT_FAILED', linkUrl: '/admin/escrow',
          });
        }
      } catch (err) {
        logger.warn('[PaymentReconcile] Could not look up an unconfirmed payout', { escrowId: row.id, leg, error: err.message || razorpayText(err) });
      }
    }
  }
  return settled;
}
const razorpayText = (err) => err?.error?.description || (err?.statusCode ? `HTTP ${err.statusCode}` : 'unknown error');

const STUCK_STATE_MS = 10 * 60 * 1000;         // a claim older than this with no result is not "in progress" any more
const STUCK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // old test and seed rows are not re-scanned for ever

// Audit Nov 2026, F2. refund() marks REFUNDED and release() marks RELEASED BEFORE they call Razorpay (that is what stops a
// double click paying twice). If the server dies between the mark and the call, the row says money moved and none did.
// Nothing here moves money: it tells the admins, once per escrow and kind, by notification and email. The one row change
// is a partner payout stuck in "claiming" (the server died mid-payout), which becomes "unconfirmed" so that "Pay partner"
// is offered again and looks the payout up at RazorpayX before creating anything.
async function alertStuckMoneyStates(now = Date.now()) {
  const cutoff = new Date(now - STUCK_STATE_MS);
  const since = new Date(now - STUCK_LOOKBACK_MS);
  const [refunded, released, partnerStuck] = await Promise.all([
    // A real refund always leaves an id in refundIds (Razorpay's, or "manual:..." for one made by hand).
    prisma.escrowTransaction.findMany({ where: { status: 'REFUNDED', refundedAt: { lte: cutoff, gte: since }, refundIds: { isEmpty: true } } }),
    // Candidates only; a confirmed manual transfer also has no payout id, so the release audit entry decides below.
    prisma.escrowTransaction.findMany({ where: { status: 'RELEASED', releasedAt: { lte: cutoff, gte: since }, OR: [{ razorpayPayoutId: null }, { razorpayPayoutId: { isSet: false } }] } }),
    prisma.escrowTransaction.findMany({ where: { status: 'RELEASED', partnerPayoutStatus: { in: ['claiming', 'unconfirmed'] }, updatedAt: { lte: cutoff } } }),
  ]);

  const found = [];
  for (const e of refunded) {
    found.push({ e, action: 'ALERT_REFUND_NOT_SENT', title: 'Refund marked but not sent', text: `An escrow of ₹${e.amount.toLocaleString('en-IN')} is marked REFUNDED but no refund was recorded at Razorpay. The buyer may not have been paid. Check the payment in Razorpay; if no refund exists there, refund it by hand and record it.` });
  }
  for (const e of released) {
    if (e.sellerPayoutStatus) continue; // a payout was attempted and its state is known
    const audited = await prisma.auditLog.findFirst({ where: { action: 'ESCROW_RELEASED', targetId: e.id }, select: { id: true } });
    if (audited) continue; // release() ran to its end (for example a confirmed manual transfer)
    found.push({ e, action: 'ALERT_RELEASE_NOT_PAID', title: 'Release marked but no payout made', text: `An escrow of ₹${e.amount.toLocaleString('en-IN')} is marked RELEASED but no payout was created and the release never finished. The seller has not been paid by the app. Check RazorpayX for a payout with this escrow's reference, then pay or correct it.` });
  }
  for (const e of partnerStuck) {
    if (e.partnerPayoutStatus === 'claiming') {
      const moved = await prisma.escrowTransaction.updateMany({
        where: { id: e.id, partnerPayoutStatus: 'claiming', updatedAt: { lte: cutoff } },
        data: { partnerPayoutStatus: 'unconfirmed', partnerPayoutFailureReason: 'The payout was started and never finished; it may or may not exist. "Pay partner" looks it up first.' },
      });
      if (moved.count === 0) continue; // it finished while we were looking
      e.partnerPayoutStatus = 'unconfirmed';
    }
    found.push({ e, action: 'ALERT_PARTNER_PAYOUT_STUCK', title: 'Partner payout needs a check', text: `The partner payout on an escrow of ₹${e.amount.toLocaleString('en-IN')} was started and its result is not known. Open Escrow and press "Pay partner": it first checks RazorpayX for the earlier payout, so nothing is paid twice.` });
  }

  let alerted = 0;
  for (const { e, action, title, text } of found) {
    const done = await prisma.auditLog.findFirst({ where: { action, targetId: e.id }, select: { id: true } });
    if (done) continue;
    await notifyAdmins({ title, message: text, type: 'ESCROW_PAYOUT_FAILED', linkUrl: '/admin/escrow' });
    await alertStaff(title, `<p>${text}</p><p>Escrow id: ${e.id}</p>`);
    await createAuditLog({ actorRole: 'SYSTEM', action, targetType: 'EscrowTransaction', targetId: e.id, after: { status: e.status, partnerPayoutStatus: e.partnerPayoutStatus ?? null } });
    logger.error(`[PaymentReconcile] ${title}`, { escrowId: e.id, status: e.status });
    alerted++;
  }
  return alerted;
}

async function runOnce() {
  const [healedEscrows, healedSubscriptions, reconciledPayouts, unconfirmedPayouts, stuckAlerts] = await Promise.all([
    reconcilePendingEscrows(),
    reconcilePendingSubscriptions(),
    reconcileStuckPayouts(),
    // These two must never stop the three above (or each other) from reporting.
    reconcileUnconfirmedPayouts().catch((err) => { logger.error('[PaymentReconcile] unconfirmed-payout check failed', { error: err.message }); return 0; }),
    alertStuckMoneyStates().catch((err) => { logger.error('[PaymentReconcile] stuck-state check failed', { error: err.message }); return 0; }),
  ]);
  const result = { healedEscrows, healedSubscriptions, reconciledPayouts, unconfirmedPayouts, stuckAlerts };
  if (healedEscrows || healedSubscriptions || reconciledPayouts || unconfirmedPayouts || stuckAlerts) {
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

module.exports = { start, runOnce, reconcileUnconfirmedPayouts, alertStuckMoneyStates };
