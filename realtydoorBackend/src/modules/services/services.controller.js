const { success, created } = require('../../utils/ApiResponse');
const service = require('./services.service');
const { verifyPaymentSignature } = require('../../lib/razorpay');
const { verifyPaymentSchema } = require('../../lib/paymentSchemas');
const { createOrderSchema, SERVICE_CATEGORIES } = require('./services.validator');
const ApiError = require('../../utils/ApiError');

async function getAll(req, res, next) {
  try {
    // L4 fix — same pattern as BE-11's escrow status filter: validated
    // against the known list before reaching the DB, instead of a typo
    // silently returning an empty result set.
    if (req.query.category && !SERVICE_CATEGORIES.includes(req.query.category)) {
      throw new ApiError(400, `Invalid category. Must be one of: ${SERVICE_CATEGORIES.join(', ')}`, { code: 'INVALID_CATEGORY' });
    }
    const services = await service.getAllServices(req.query.category);
    success(res, services);
  } catch (err) { next(err); }
}

async function createOrder(req, res, next) {
  try {
    const { serviceId } = createOrderSchema.parse(req.body);
    const result = await service.createServiceOrder(req.user.id, serviceId);
    created(res, result, 'Order created');
  } catch (err) { next(err); }
}

async function verifyPayment(req, res, next) {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = verifyPaymentSchema.parse(req.body ?? {});
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      throw new ApiError(400, 'Invalid payment signature');
    }
    const subscription = await service.activateSubscription(razorpayOrderId, razorpayPaymentId, req.user.id);
    success(res, subscription, 'Payment verified');
  } catch (err) { next(err); }
}

module.exports = { getAll, createOrder, verifyPayment };
