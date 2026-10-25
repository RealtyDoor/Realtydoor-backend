const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { razorpay, createOrder } = require('../../lib/razorpay');
const { withCache } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { createNotification, notifyAdmins } = require('../../lib/notifications');
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

  // B118 — a buyer could pay again for a plan they already hold (the confirm
  // page had no way to know). An already-paid, unexpired subscription to the
  // same service blocks a new order; a PENDING one is handled by BE-7 below.
  const active = await prisma.userSubscription.findFirst({
    where: { userId, serviceId, paymentStatus: 'SUCCESS', endDate: { gt: new Date() } },
    select: { endDate: true },
  });
  if (active) {
    throw new ApiError(400, `You already have an active ${service.name} plan until ${active.endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`, {
      code: 'SUBSCRIPTION_ALREADY_ACTIVE',
      activeUntil: active.endDate,
    });
  }

  // BE-7 — previously every call created a brand-new Razorpay order and
  // UserSubscription row, so a double-click (or a retried request after a
  // slow response) left an orphaned order/row per click. A recent,
  // still-PENDING subscription for the same (userId, serviceId) means that
  // attempt is still live — reuse its order instead of creating another.
  const recentPending = await prisma.userSubscription.findFirst({
    where: { userId, serviceId, paymentStatus: 'PENDING', startDate: { gte: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) } },
    orderBy: { startDate: 'desc' },
  });
  // Live-tested finding — Razorpay rejects a bad/expired key pair with a
  // plain {statusCode, error} throw (not an Error instance), which
  // previously fell through to the generic 500 INTERNAL_ERROR instead of
  // a proper 502 RAZORPAY_ERROR. Only the Razorpay calls themselves are
  // wrapped — a Prisma error just below must not be mislabeled as one.
  if (recentPending) {
    let razorpayOrder;
    try {
      razorpayOrder = await razorpay.orders.fetch(recentPending.razorpayOrderId);
    } catch (err) {
      throw new ApiError(502, `Could not fetch the existing Razorpay order: ${err?.error?.description || err.message || 'Unknown error'}`, { code: 'RAZORPAY_ERROR' });
    }
    return { subscription: recentPending, razorpayOrder, key: process.env.RAZORPAY_KEY_ID };
  }

  const amountInPaise = Math.round(service.price * 100);
  let order;
  try {
    order = await createOrder(amountInPaise, `svc_${Date.now()}`);
  } catch (err) {
    throw new ApiError(502, `Could not create the Razorpay order: ${err?.error?.description || err.message || 'Unknown error'}`, { code: 'RAZORPAY_ERROR' });
  }

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
      throw new ApiError(502, 'Could not verify the payment with Razorpay. Please try again.', { code: 'RAZORPAY_ERROR' }); // BE-16
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
    // The money book: one line per paid subscription (never throws; see ledger.recordSafe).
    try {
      const { getMoneySettings } = require('../money/moneyConfig');
      const settings = await getMoneySettings();
      await require('../money/ledger.service').onServicePaid(updated, service, { gstPct: settings?.commission?.gstPct ?? 18 });
    } catch (err) {
      logger.error('[Services] could not write the ledger line for a paid subscription', { subscriptionId: updated.id, error: err.message });
    }
    await createNotification({
      userId: updated.userId,
      title: 'Service Activated',
      message: `Your ${service?.name} service is now active.`,
      type: 'SERVICE_ACTIVATED',
      linkUrl: '/user/subscriptions',
    });
    // B68 — the auto-created setup ticket was only visible as a sidebar badge.
    await notifyAdmins({
      title: 'New service subscription',
      message: `${service?.name || 'A service'} was purchased; a setup ticket is waiting to be assigned.`,
      type: 'TICKET_NEW',
      linkUrl: '/admin/tickets',
    });
    const user = await prisma.user.findUnique({ where: { id: updated.userId } });
    if (user && service) await sendServiceActivated(user.email, service.name, user);
  })().catch((err) => logger.warn('[Services] Post-activation notification/email failed', { subscriptionId: updated.id, error: err.message }));

  return updated;
}

module.exports = { getAllServices, createServiceOrder, activateSubscription };
