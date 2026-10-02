const { verifyWebhookSignature } = require('../../lib/razorpay');
const { confirmPayment } = require('../escrow/escrow.service');
const prisma = require('../../lib/prisma');
const { sendServiceActivated, sendEscrowPaymentFailed } = require('../../lib/email');
const { createNotification, broadcastNotification } = require('../../lib/notifications');
const logger = require('../../lib/logger');

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
  try {
    const signature = req.headers['x-razorpay-signature'];

    if (!verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let payload;
    ({ event, payload } = req.body);

    if (event === 'payment.captured') {
      const { order_id: orderId, id: paymentId } = payload.payment.entity;

      // Route: escrow payment
      const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId: orderId } });
      if (escrow) {
        await confirmPayment(orderId, paymentId);
        return res.json({ status: 'ok' });
      }

      // Route: service subscription payment
      const subscription = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
      if (subscription) {
        // Idempotency: skip if already processed
        if (subscription.paymentStatus === 'SUCCESS') return res.json({ status: 'ok' });

        const now = new Date();
        const endDate = new Date(now);
        endDate.setFullYear(endDate.getFullYear() + 1);

        await prisma.userSubscription.update({
          where: { razorpayOrderId: orderId },
          data: {
            paymentStatus: 'SUCCESS',
            razorpayPaymentId: paymentId,
            startDate: now,
            endDate,
          },
        });

        const service = await prisma.service.findUnique({ where: { id: subscription.serviceId } });
        await prisma.serviceTicket.create({
          data: {
            userId: subscription.userId,
            subscriptionId: subscription.id,
            subject: `${service?.name} — Initial Setup`,
            description: 'Service activated. Admin will coordinate.',
            status: 'OPEN',
          },
        });

        await createNotification({
          userId: subscription.userId,
          title: 'Service Activated',
          message: `Your ${service?.name} service is now active.`,
          type: 'SERVICE_ACTIVATED',
          linkUrl: '/dashboard/services',
        });

        const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
        if (user && service) sendServiceActivated(user.email, service.name).catch(() => {});
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
          return res.json({ status: 'ok' });
        }

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

        return res.json({ status: 'ok' });
      }

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
          linkUrl: '/dashboard/services',
        });
      }
    }

    if (event === 'refund.created') {
      const { payment_id: paymentId, id: refundId, amount } = payload.refund.entity;
      const amountRupees = `₹${(amount / 100).toLocaleString('en-IN')}`;

      const escrow = await prisma.escrowTransaction.findFirst({ where: { razorpayPaymentId: paymentId } });
      if (escrow && escrow.status !== 'REFUNDED') {
        await prisma.escrowTransaction.update({
          where: { id: escrow.id },
          data: { status: 'REFUNDED', razorpayRefundId: refundId, refundedAt: new Date() },
        });
        await createNotification({
          userId: escrow.buyerId,
          title: 'Token Advance Refunded',
          message: `Your token advance of ${amountRupees} has been refunded.`,
          type: 'PAYMENT_REFUNDED',
          linkUrl: `/user/inquiries/${escrow.leadId}`,
        });
      }

      const subscription = await prisma.userSubscription.findFirst({ where: { razorpayPaymentId: paymentId } });
      if (subscription && subscription.paymentStatus !== 'REFUNDED') {
        await prisma.userSubscription.update({
          where: { id: subscription.id },
          data: { paymentStatus: 'REFUNDED' },
        });
        await createNotification({
          userId: subscription.userId,
          title: 'Service Payment Refunded',
          message: `Your service subscription payment of ${amountRupees} has been refunded.`,
          type: 'PAYMENT_REFUNDED',
          linkUrl: '/dashboard/services',
        });
      }
    }

    if (event === 'transfer.settled') {
      // `source` is the payment the transfer was made from — Razorpay's own
      // record of a real, completed transfer, independent of whether our
      // release() call's own DB write succeeded.
      const { id: transferId, source: sourcePaymentId } = payload.transfer.entity;
      let escrow = await prisma.escrowTransaction.findFirst({ where: { razorpayTransferId: transferId } });

      // Reconciliation fallback: escrow.service.js's release() now claims
      // RELEASED atomically *before* calling Razorpay (so the escrow can
      // never be stuck showing HELD while money actually moved), but its
      // final write — persisting razorpayTransferId itself — could still
      // fail after a successful transfer. That escrow is unreachable by
      // transferId above; razorpayPaymentId, however, is written back at
      // confirmPayment time, long before any release, so it's always
      // reliably present. This is the only remaining signal for that narrow
      // failure window, so use it to find and backfill the record.
      if (!escrow && sourcePaymentId) {
        escrow = await prisma.escrowTransaction.findFirst({ where: { razorpayPaymentId: sourcePaymentId } });
        if (escrow) {
          const needsStatusFix = escrow.status !== 'RELEASED';
          await prisma.escrowTransaction.update({
            where: { id: escrow.id },
            data: {
              razorpayTransferId: transferId,
              ...(needsStatusFix && { status: 'RELEASED', releasedAt: escrow.releasedAt || new Date() }),
            },
          });
          logger.warn('[RazorpayWebhook] Reconciled escrow via transfer.settled — razorpayTransferId (and possibly status) was missing', {
            transferId, escrowId: escrow.id, hadWrongStatus: needsStatusFix,
          });
        }
      }

      if (escrow) {
        logger.info('[RazorpayWebhook] Escrow transfer settled', { transferId, escrowId: escrow.id });
        await createNotification({
          userId: escrow.buyerId,
          title: 'Token Advance Transferred to Seller',
          message: 'The token advance for your property deal has been successfully transferred to the seller.',
          type: 'ESCROW_RELEASED',
          linkUrl: `/user/inquiries/${escrow.leadId}`,
        });
      }
    }

    // A RazorpayX payout created during release() returned success
    // synchronously (so the escrow was already marked RELEASED) but then
    // failed or was reversed afterward — the money didn't actually reach the
    // seller/partner. There's no safe automatic recovery here (the seller's
    // payout may or may not have already landed elsewhere), so this flags the
    // escrow for manual review instead of silently leaving it RELEASED with
    // no money moved, or guessing at a revert that could race a legitimate retry.
    if (event === 'payout.failed' || event === 'payout.reversed') {
      const { id: payoutId, status, status_details: statusDetails } = payload.payout.entity;
      const escrow = await prisma.escrowTransaction.findFirst({
        where: { OR: [{ razorpayPayoutId: payoutId }, { razorpayPartnerPayoutId: payoutId }] },
      });

      // Re-checking status in (RELEASED, HELD_PAYOUT_FAILED) rather than just
      // RELEASED — a release() with both seller and partner payouts can have
      // each leg fail independently. Without this, the first leg's failure
      // flips status to HELD_PAYOUT_FAILED, and the second leg's own failure
      // webhook would silently no-op instead of being recorded. The payoutId
      // check in adminNote is what makes a duplicate delivery of the *same*
      // webhook a no-op instead.
      if (escrow && ['RELEASED', 'HELD_PAYOUT_FAILED'].includes(escrow.status) && !escrow.adminNote?.includes(payoutId)) {
        const leg = escrow.razorpayPayoutId === payoutId ? 'seller' : 'partner';
        const reason = statusDetails?.description || status;

        await prisma.escrowTransaction.update({
          where: { id: escrow.id },
          data: {
            status: 'HELD_PAYOUT_FAILED',
            adminNote: `${escrow.adminNote ? `${escrow.adminNote} | ` : ''}${leg} payout ${status} (${payoutId}): ${reason} — needs manual review`,
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

        logger.error('[RazorpayWebhook] Escrow payout failed/reversed after release — flagged for manual review', {
          payoutId, escrowId: escrow.id, leg, status, reason,
        });
      }
    }
  } catch (err) {
    logger.error('[RazorpayWebhook] Error processing event', { event, error: err.message });
  }

  res.json({ status: 'ok' });
}

module.exports = { razorpay };
