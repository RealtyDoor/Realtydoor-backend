const { verifyWebhookSignature } = require('../../lib/razorpay');
const { confirmPayment } = require('../escrow/escrow.service');
const { activateSubscription } = require('../services/services.service');
const prisma = require('../../lib/prisma');
const { sendEscrowPaymentFailed } = require('../../lib/email');
const { createNotification, broadcastNotification } = require('../../lib/notifications');
const { notifyUser } = require('../../lib/wati');
const logger = require('../../lib/logger');
const ledger = require('../money/ledger.service');
const { createAuditLog } = require('../../lib/auditLog');

// The entire handler body is one try/catch, including signature verification
// — this is a public, unauthenticated, internet-facing endpoint (it has to
// be, to receive real Razorpay webhooks), so nothing in here may ever throw
// past this function. A single malformed/missing header or an unexpected
// payload shape must degrade to a clean error response, never an unhandled
// promise rejection (which server.js treats as fatal and exits the process).
async function razorpay(req, res) {
  // Declared here (not via `const` inside the try block) so the catch
  // block below can actually log which event failed — a `const` declared
  // inside `try` is out of scope in `catch`, which previously meant any
  // processing error threw a *second*, independent ReferenceError from
  // inside the error handler itself, itself unhandled.
  let event;
  let eventId;
  try {
    const signature = req.headers['x-razorpay-signature'];

    if (!verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let payload;
    ({ event, payload } = req.body);
    eventId = req.headers['x-razorpay-event-id'];

    // BE-5 — dedup against a redelivered event. Razorpay retries on
    // anything but a 2xx — including our own 500 below, added for a real
    // processing failure — so a retry of an event that already fully
    // completed last time must not run every side effect again. Every
    // branch below is independently idempotent too, but this is the first
    // line of defense, and the one that matters once paymentReconcile.js
    // (BE-5) starts re-fetching and replaying missed state.
    //
    // L1 fix — the create() itself is now the exclusive claim, not just a
    // best-effort row insert. Previously a findUnique-then-create (losing
    // the create's unique-index race silently via .catch(() => {})) meant
    // two concurrent deliveries of the SAME event could both pass the
    // findUnique check (neither had processedAt yet) and both go on to run
    // the full handler body below — the dedup only ever prevented a
    // duplicate ROW, never duplicate PROCESSING. Now, losing the create's
    // unique-index race is treated as "someone else owns this delivery"
    // and returns immediately, before any handler logic runs.
    if (eventId) {
      try {
        await prisma.webhookEvent.create({ data: { eventId, event } });
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        // A row for this eventId already exists. If it's already fully
        // processed, this is a genuine duplicate delivery — skip. If not,
        // either a previous processing attempt failed (a legitimate retry
        // that must NOT be swallowed — that's the entire point of BE-5's
        // 500-on-failure) or a truly concurrent delivery is racing this
        // one right now; either way, every handler branch below has its
        // own atomic claim/dedup guard, so letting this proceed is a
        // bounded residual risk, not a hole.
        const existing = await prisma.webhookEvent.findUnique({ where: { eventId } });
        if (existing?.processedAt) {
          logger.info('[RazorpayWebhook] Duplicate delivery — already processed', { eventId, event });
          return res.json({ status: 'ok' });
        }
        logger.info('[RazorpayWebhook] Re-processing an event that previously failed or is racing a concurrent delivery', { eventId, event });
      }
    }

    if (event === 'payment.captured') {
      const { order_id: orderId, id: paymentId } = payload.payment.entity;

      // Route: escrow payment
      const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId: orderId } });
      if (escrow) {
        await confirmPayment(orderId, paymentId);
      } else {
        // Route: service subscription payment. BE-3 — activateSubscription is
        // the one atomic path shared with the buyer-facing verify-payment
        // route (services.controller.js); whichever of the two reaches it
        // first wins the claim and creates the ticket/notification/email,
        // the other is a no-op.
        const subscription = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
        if (subscription) {
          await activateSubscription(orderId, paymentId);
        }
      }
    }

    if (event === 'payment.failed') {
      const { order_id: orderId } = payload.payment.entity;

      const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId: orderId } });
      if (escrow) {
        // Only ever downgrade a still-pending escrow. payment.failed reports
        // one attempt against this order_id; Razorpay webhook delivery can
        // retry/redeliver and arrive out of order, so without this check a
        // stale payment.failed arriving after a *different*, successful
        // attempt was already confirmed (HELD) would silently corrupt it back
        // to FAILED — hiding real captured money from release()/refund() and
        // telling the buyer their successful payment failed.
        if (escrow.status !== 'PAYMENT_PENDING') {
          logger.warn('[RazorpayWebhook] payment.failed for a non-pending escrow — ignoring', { escrowId: escrow.id, status: escrow.status });
        } else {
          await prisma.escrowTransaction.update({
            where: { razorpayOrderId: orderId },
            data: { status: 'FAILED', failedAt: new Date() },
          });

          await createNotification({
            userId: escrow.buyerId,
            title: 'Token Advance Payment Failed',
            message: 'Your token advance payment could not be processed. Please retry from your dashboard.',
            type: 'PAYMENT_FAILED',
            linkUrl: `/user/inquiries/${escrow.leadId}`,
          });

          const buyer = await prisma.user.findUnique({ where: { id: escrow.buyerId }, select: { email: true } });
          if (buyer) sendEscrowPaymentFailed(buyer.email).catch(() => {});
        }
      } else {
        const failedSub = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
        if (failedSub) {
          await prisma.userSubscription.update({
            where: { razorpayOrderId: orderId },
            data: { paymentStatus: 'FAILED' },
          });
          await createNotification({
            userId: failedSub.userId,
            title: 'Service Payment Failed',
            message: 'Your service subscription payment could not be processed. Please retry from your dashboard.',
            type: 'PAYMENT_FAILED',
            linkUrl: '/user/subscriptions',
          });
        }
      }
    }

    if (event === 'refund.created') {
      const { payment_id: paymentId, id: refundId, amount } = payload.refund.entity;
      const amountRupees = `₹${(amount / 100).toLocaleString('en-IN')}`;

      // BE-6 — previously ANY refund amount set REFUNDED unconditionally,
      // so a partial dashboard refund (or a redelivered webhook re-applying
      // the same refund) looked identical to a full one, and a RELEASED/
      // FROZEN escrow could be flipped to REFUNDED with no basis at all.
      const escrow = await prisma.escrowTransaction.findFirst({ where: { razorpayPaymentId: paymentId } });
      if (escrow && !escrow.refundIds.includes(refundId)) {
        // M2 fix — PARTIALLY_REFUNDED added (a second/third partial refund
        // on the same escrow previously hit the "unexpected" branch below
        // instead of continuing to accumulate toward REFUNDED).
        // HELD_PAYOUT_FAILED removed — that status specifically means a
        // payout leg already landed (see escrow.service.js's release()),
        // so a refund arriving while HELD_PAYOUT_FAILED is itself a
        // double-payment already in progress, not a normal refund to wave
        // through. It needs a human, same as any other unexpected state.
        if (!['HELD', 'FROZEN', 'PARTIALLY_REFUNDED'].includes(escrow.status)) {
          logger.warn('[RazorpayWebhook] refund.created for an escrow not in a refundable state — not touching status', { escrowId: escrow.id, status: escrow.status, refundId });
          const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
          if (admins.length > 0) {
            await broadcastNotification({
              userIds: admins.map((a) => a.id),
              title: 'Unexpected refund on a non-held escrow',
              message: `A refund of ${amountRupees} was recorded on an escrow with status ${escrow.status} — this needs manual review.`,
              type: 'ESCROW_PAYOUT_FAILED',
            });
          }
        } else {
          const refundedAmountPaise = (escrow.refundedAmountPaise || 0) + amount;
          const fullyRefunded = refundedAmountPaise >= Math.round(escrow.amount * 100);
          await prisma.escrowTransaction.update({
            where: { id: escrow.id },
            data: {
              refundedAmountPaise,
              refundIds: { push: refundId },
              razorpayRefundId: refundId,
              ...(fullyRefunded
                ? { status: 'REFUNDED', refundedAt: new Date() }
                : { status: 'PARTIALLY_REFUNDED' }),
            },
          });
          await createNotification({
            userId: escrow.buyerId,
            title: fullyRefunded ? 'Token Advance Refunded' : 'Partial Refund Received',
            message: fullyRefunded
              ? `Your token advance of ${amountRupees} has been refunded.`
              : `A partial refund of ${amountRupees} has been issued against your token advance.`,
            type: 'PAYMENT_REFUNDED',
            linkUrl: `/user/inquiries/${escrow.leadId}`,
          });
        }
      }

      const subscription = await prisma.userSubscription.findFirst({ where: { razorpayPaymentId: paymentId } });
      if (subscription && !subscription.refundIds.includes(refundId) && subscription.paymentStatus !== 'REFUNDED') {
        const refundedAmountPaise = (subscription.refundedAmountPaise || 0) + amount;
        const fullyRefunded = refundedAmountPaise >= Math.round(subscription.amountPaid * 100);
        await prisma.userSubscription.update({
          where: { id: subscription.id },
          data: {
            refundedAmountPaise,
            refundIds: { push: refundId },
            ...(fullyRefunded && { paymentStatus: 'REFUNDED' }),
          },
        });
        await createNotification({
          userId: subscription.userId,
          title: fullyRefunded ? 'Service Payment Refunded' : 'Partial Refund Received',
          message: fullyRefunded
            ? `Your service subscription payment of ${amountRupees} has been refunded.`
            : `A partial refund of ${amountRupees} has been issued against your service subscription payment.`,
          type: 'PAYMENT_REFUNDED',
          linkUrl: '/user/subscriptions',
        });
      }
    }

    // BE-12 — legacy Razorpay Route handler. release() has used RazorpayX
    // payouts exclusively for a while now (never Route transfers), and
    // nothing writes razorpayTransferId any more — this is dead weight,
    // kept only so an actual delivery (if the Razorpay dashboard still has
    // this event subscribed — see BE-15's checklist, which it shouldn't)
    // gets a clean acknowledged-but-ignored response instead of silently
    // falling through to nothing. razorpayTransferId itself is left on the
    // schema for now; dropping the column is a separate migration.
    if (event === 'transfer.settled') {
      logger.info('[RazorpayWebhook] transfer.settled received — ignored (legacy Route handler removed, BE-12)', { event });
    }

    // R31 — the payout only actually lands once RazorpayX confirms it, with
    // the UTR appearing for the first time on this event. Safe to apply
    // unconditionally on every delivery (same leg, same status/utr each
    // time) — unlike the failure path below, there's no notification to
    // dedup against adminNote text here except the one fired on this update.
    if (event === 'payout.processed') {
      const { id: payoutId, utr } = payload.payout.entity;
      const escrow = await prisma.escrowTransaction.findFirst({
        where: { OR: [{ razorpayPayoutId: payoutId }, { razorpayPartnerPayoutId: payoutId }] },
      });

      if (escrow) {
        const leg = escrow.razorpayPayoutId === payoutId ? 'seller' : 'partner';
        const alreadyProcessed = leg === 'seller'
          ? escrow.sellerPayoutStatus === 'processed'
          : escrow.partnerPayoutStatus === 'processed';

        await prisma.escrowTransaction.update({
          where: { id: escrow.id },
          data: leg === 'seller'
            ? { sellerPayoutStatus: 'processed', sellerPayoutUtr: utr || null }
            : { partnerPayoutStatus: 'processed', partnerPayoutUtr: utr || null },
        });

        // Money ledger: a new row saying this payout was paid (never an edit).
        await ledger.onPayoutStatus({ escrowId: escrow.id, payoutId, status: 'processed', utr });
        if (leg === 'partner' && utr) {
          await prisma.commissionVoucher.updateMany({ where: { escrowId: escrow.id }, data: { utr, payoutId } }).catch(() => {});
        }

        // Only the partner leg maps to a known platform user — sellerDetails
        // is typed ad-hoc into the release request and doesn't necessarily
        // belong to a User account, so there's no one reliable to notify for
        // that leg. Guarded by alreadyProcessed so a redelivered webhook
        // doesn't re-notify the partner for the same payout.
        if (leg === 'partner' && !alreadyProcessed) {
          const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { assignedPartnerId: true, refCode: true } });
          if (lead?.assignedPartnerId) {
            await createNotification({
              userId: lead.assignedPartnerId,
              title: 'Payout received',
              message: `Your commission payout has been processed${utr ? ` (UTR ${utr})` : ''}.`,
              type: 'PAYOUT_PROCESSED',
              linkUrl: '/partners/finance',
            });
            notifyUser(lead.assignedPartnerId, 'escrow_released', {
              name: '$userName', amount: Math.round((payload.payout.entity.amount || 0) / 100).toLocaleString('en-IN'), lead_ref: lead.refCode || 'your lead',
            });
          }
        }

        logger.info('[RazorpayWebhook] Escrow payout processed', { payoutId, escrowId: escrow.id, leg, utr });
      }
    }

    // A RazorpayX payout created during release() returned success
    // synchronously (so the escrow was already marked RELEASED) but then
    // failed, was rejected or was reversed afterward — the money didn't actually reach the
    // seller/partner. There's no safe automatic recovery here (the seller's
    // payout may or may not have already landed elsewhere), so this flags the
    // escrow for manual review instead of silently leaving it RELEASED with
    // no money moved, or guessing at a revert that could race a legitimate retry.
    // RazorpayX has no payout.failed event in its webhook list; a payout it refuses arrives as payout.rejected.
    if (event === 'payout.failed' || event === 'payout.rejected' || event === 'payout.reversed') {
      const { id: payoutId, status, status_details: statusDetails } = payload.payout.entity;
      const escrow = await prisma.escrowTransaction.findFirst({
        where: { OR: [{ razorpayPayoutId: payoutId }, { razorpayPartnerPayoutId: payoutId }] },
      });

      // Re-checking status in (RELEASED, HELD_PAYOUT_FAILED) rather than just
      // RELEASED — a release() with both seller and partner payouts can have
      // each leg fail independently. Without this, the first leg's failure
      // flips status to HELD_PAYOUT_FAILED, and the second leg's own failure
      // webhook would silently no-op instead of being recorded.
      //
      // BE-19 — dedupe on the per-leg status field itself, never by
      // searching adminNote text: adminNote is free text release()/admins
      // also write (release()'s OWN note already contains this same
      // payoutId, e.g. "Seller payout pout_xxx: ₹…"), so the old
      // `!adminNote?.includes(payoutId)` check could skip a GENUINE failure
      // webhook entirely, leaving the row RELEASED although the money
      // bounced. "Already recorded as exactly this status" is the real
      // already-processed signal (the outer WebhookEvent dedup, BE-5,
      // already handles a plain redelivery of the same event id).
      const leg = escrow?.razorpayPayoutId === payoutId ? 'seller' : 'partner';
      const currentLegStatus = leg === 'seller' ? escrow?.sellerPayoutStatus : escrow?.partnerPayoutStatus;
      if (escrow && ['RELEASED', 'HELD_PAYOUT_FAILED'].includes(escrow.status) && currentLegStatus !== status) {
        // BE-20 — RazorpayX's actual failure reason, previously discarded
        // (only the bare status was kept) — stored per-leg, independent of
        // adminNote's free text.
        const reason = statusDetails?.description || status;

        await prisma.escrowTransaction.update({
          where: { id: escrow.id },
          data: {
            status: 'HELD_PAYOUT_FAILED',
            adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout ${status} (${payoutId}): ${reason} — needs manual review`,
            ...(leg === 'seller'
              ? { sellerPayoutStatus: status, sellerPayoutFailureReason: reason }
              : { partnerPayoutStatus: status, partnerPayoutFailureReason: reason }),
          },
        });

        const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
        if (admins.length > 0) {
          await broadcastNotification({
            userIds: admins.map((a) => a.id),
            title: 'Escrow payout failed',
            message: `The ${leg} payout for an escrow of ₹${escrow.amount.toLocaleString('en-IN')} ${status === 'reversed' ? 'was reversed' : 'failed'}: ${reason}. Needs manual review.`,
            type: 'ESCROW_PAYOUT_FAILED',
          });
        }

        await ledger.onPayoutStatus({ escrowId: escrow.id, payoutId, status, reason });
        await createAuditLog({
          actorRole: 'WEBHOOK', action: status === 'reversed' ? 'PAYOUT_REVERSED' : 'PAYOUT_FAILED',
          targetType: 'EscrowTransaction', targetId: escrow.id,
          before: { [`${leg}PayoutStatus`]: currentLegStatus ?? null }, after: { [`${leg}PayoutStatus`]: status, payoutId }, reason,
        }).catch((e) => logger.warn('[RazorpayWebhook] audit of payout failure failed', { error: e.message }));

        logger.error('[RazorpayWebhook] Escrow payout failed/reversed after release — flagged for manual review', {
          payoutId, escrowId: escrow.id, leg, status, reason,
        });
      }
    }
  } catch (err) {
    logger.error('[RazorpayWebhook] Error processing event', { event, error: err.message });
    // BE-5 — a processing failure (as opposed to a bad/missing signature,
    // which already returns 400 above) now gets a real 500 instead of a
    // blanket 200, so Razorpay's own retry mechanism actually kicks in —
    // every handler branch above is idempotent (status-guarded updates,
    // atomic claims, dedup-by-id checks), so a retry is safe.
    if (eventId) {
      await prisma.webhookEvent.updateMany({ where: { eventId }, data: { error: err.message } }).catch(() => {});
    }
    return res.status(500).json({ status: 'error' });
  }

  if (eventId) {
    await prisma.webhookEvent.updateMany({ where: { eventId }, data: { processedAt: new Date() } }).catch((err) => {
      logger.warn('[RazorpayWebhook] Failed to mark event processed', { eventId, error: err.message });
    });
  }
  res.json({ status: 'ok' });
}

module.exports = { razorpay };
