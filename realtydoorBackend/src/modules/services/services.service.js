const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { razorpay, createOrder } = require('../../lib/razorpay');
const { withCache } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { createNotification } = require('../../lib/notifications');
const { sendServiceActivated } = require('../../lib/email');
const logger = require('../../lib/logger');

// BE-8 — the FE previously fell back to services[0] when no MAINTENANCE
// service was returned (fixed in the FE by refusing that fallback instead),
// which could charge for the wrong service. The seed already guarantees at
// least one active MAINTENANCE service exists (prisma/seed.js); this is the
// filter so the FE can actually ask for one directly instead of filtering
// client-side out of the full list.
async function getAllServices(category) {
  return withCache(CACHE_KEYS.servicesList(category), 900, () => prisma.service.findMany({
    where: { isActive: true, ...(category && { category }) },
    orderBy: { sortOrder: 'asc' },
  }));
}

const DUPLICATE_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

async function createServiceOrder(userId, serviceId) {
  const service = await prisma.service.findUnique({ where: { id: serviceId, isActive: true } });
  if (!service) throw new ApiError(404, 'Service not found');

  // BE-7 — previously every call created a brand-new Razorpay order and
  // UserSubscription row, so a double-click (or a retried request after a
  // slow response) left an orphaned order/row per click. A recent,
  // still-PENDING subscription for the same (userId, serviceId) means that
  // attempt is still live — reuse its order instead of creating another.
  const recentPending = await prisma.userSubscription.findFirst({
    where: { userId, serviceId, paymentStatus: 'PENDING', startDate: { gte: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) } },
    orderBy: { startDate: 'desc' },
  });
  if (recentPending) {
    const razorpayOrder = await razorpay.orders.fetch(recentPending.razorpayOrderId);
    return { subscription: recentPending, razorpayOrder, key: process.env.RAZORPAY_KEY_ID };
  }

  const amountInPaise = Math.round(service.price * 100);
  const order = await createOrder(amountInPaise, `svc_${Date.now()}`);

  const subscription = await prisma.userSubscription.create({
    data: {
      userId,
      serviceId,
      razorpayOrderId: order.id,
      paymentStatus: 'PENDING',
      amountPaid: service.price,
      amountPaidPaise: amountInPaise, // BE-9
    },
  });

  return { subscription, razorpayOrder: order, key: process.env.RAZORPAY_KEY_ID };
}

// BE-3 — one atomic activation path for both the buyer-facing verify route
// and the payment.captured webhook, which previously duplicated this (verify
// only ever set SUCCESS; the webhook alone created the ticket/notification/
// email and returned early) — on the normal flow (verify fires first, which
// is the common case), no ServiceTicket/notification/email was EVER created,
// and a race between the two paths could create two. userId is only passed
// by the buyer-facing verify controller (the webhook has no caller identity
// to scope by, same reasoning as escrow's confirmPayment/buyerId).
async function activateSubscription(orderId, paymentId, userId = null) {
  const subscription = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
  if (!subscription || (userId && subscription.userId !== userId)) {
    throw new ApiError(404, 'Subscription not found');
  }
  if (subscription.paymentStatus === 'SUCCESS') return subscription;

  // BE-10 — verify path only (userId is only ever passed by the
  // buyer-facing controller, never by the webhook), same reasoning as
  // escrow.service.js's confirmPayment: the signature alone doesn't prove
  // the payment was actually captured, and with auto-capture off a merely
  // "authorized" payment could otherwise get marked SUCCESS here.
  if (userId) {
    let payment;
    try {
      payment = await razorpay.payments.fetch(paymentId);
    } catch (err) {
      throw new ApiError(502, 'Could not verify the payment with Razorpay. Please try again.');
    }
    if (payment.order_id !== orderId) {
      throw new ApiError(400, 'This payment does not belong to this order.');
    }
    if (payment.status !== 'captured') {
      throw new ApiError(409, `Payment has not been captured yet (status: ${payment.status}).`, { code: 'PAYMENT_NOT_CAPTURED' });
    }
    if (payment.amount !== Math.round(subscription.amountPaid * 100) || payment.currency !== 'INR') {
      throw new ApiError(400, "This payment's amount or currency does not match the order.", { code: 'AMOUNT_MISMATCH' });
    }
  }

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(endDate.getFullYear() + 1);

  // Atomic claim, same shape as escrow.service.js's confirmPayment — only
  // the winner of a verify-vs-webhook (or concurrent-webhook) race creates
  // the ticket/notification/email below; the loser just returns the
  // already-activated row.
  const claim = await prisma.userSubscription.updateMany({
    where: { razorpayOrderId: orderId, paymentStatus: 'PENDING' },
    data: { paymentStatus: 'SUCCESS', razorpayPaymentId: paymentId, startDate: now, endDate },
  });
  const updated = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
  if (claim.count === 0) return updated;

  const service = await prisma.service.findUnique({ where: { id: updated.serviceId } });
  await prisma.serviceTicket.create({
    data: {
      userId: updated.userId,
      subscriptionId: updated.id,
      subject: `${service?.name} — Initial Setup`,
      description: 'Service activated. Admin will coordinate.',
      status: 'OPEN',
    },
  });

  // Fire-and-forget, same reasoning as escrow's confirmPayment — the
  // subscription is already durably SUCCESS at this point, and this is
  // reached from the buyer-facing verify controller too, so a notification/
  // email hiccup must never surface as "payment verification failed".
  (async () => {
    await createNotification({
      userId: updated.userId,
      title: 'Service Activated',
      message: `Your ${service?.name} service is now active.`,
      type: 'SERVICE_ACTIVATED',
      linkUrl: '/dashboard/services',
    });
    const user = await prisma.user.findUnique({ where: { id: updated.userId } });
    if (user && service) await sendServiceActivated(user.email, service.name, user);
  })().catch((err) => logger.warn('[Services] Post-activation notification/email failed', { subscriptionId: updated.id, error: err.message }));

  return updated;
}

module.exports = { getAllServices, createServiceOrder, activateSubscription };
