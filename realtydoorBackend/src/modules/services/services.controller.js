const { success, created } = require('../../utils/ApiResponse');
const service = require('./services.service');
const { verifyPaymentSignature } = require('../../lib/razorpay');
const ApiError = require('../../utils/ApiError');

async function getAll(req, res, next) {
  try {
    const services = await service.getAllServices();
    success(res, services);
  } catch (err) { next(err); }
}

async function createOrder(req, res, next) {
  try {
    const { serviceId } = req.body;
    const result = await service.createServiceOrder(req.user.id, serviceId);
    created(res, result, 'Order created');
  } catch (err) { next(err); }
}

async function verifyPayment(req, res, next) {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw new ApiError(400, 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required');
    }
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      throw new ApiError(400, 'Invalid payment signature');
    }
    const subscription = await service.activateSubscription(razorpayOrderId, razorpayPaymentId, req.user.id);
    success(res, subscription, 'Payment verified');
  } catch (err) { next(err); }
}

module.exports = { getAll, createOrder, verifyPayment };
