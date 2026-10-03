const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createOrder } = require('../../lib/razorpay');
const { withCache } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

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

async function confirmServicePayment(orderId, paymentId) {
  const subscription = await prisma.userSubscription.findUnique({ where: { razorpayOrderId: orderId } });
  if (!subscription) throw new ApiError(404, 'Subscription not found');
  if (subscription.paymentStatus === 'SUCCESS') return subscription;

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(endDate.getFullYear() + 1);

  return prisma.userSubscription.update({
    where: { razorpayOrderId: orderId },
    data: { paymentStatus: 'SUCCESS', razorpayPaymentId: paymentId, startDate: now, endDate },
  });
}

module.exports = { getAllServices, createServiceOrder, confirmServicePayment };
