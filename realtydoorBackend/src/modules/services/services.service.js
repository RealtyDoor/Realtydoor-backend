const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createOrder } = require('../../lib/razorpay');
const { withCache } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { createNotification } = require('../../lib/notifications');
const { sendServiceActivated } = require('../../lib/email');
const logger = require('../../lib/logger');

async function getAllServices() {
  return withCache(CACHE_KEYS.SERVICES_LIST, 900, () => prisma.service.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  }));
}

async function createServiceOrder(userId, serviceId) {
  const service = await prisma.service.findUnique({ where: { id: serviceId, isActive: true } });
  if (!service) throw new ApiError(404, 'Service not found');

  const amountInPaise = Math.round(service.price * 100);
  const order = await createOrder(amountInPaise, `svc_${Date.now()}`);

  const subscription = await prisma.userSubscription.create({
    data: {
      userId,
      serviceId,
      razorpayOrderId: order.id,
      paymentStatus: 'PENDING',
      amountPaid: service.price,
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
