const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./escrow.service');
const { createOrderSchema, releaseEscrowSchema } = require('./escrow.validator');
const { verifyPaymentSignature } = require('../../lib/razorpay');
const ApiError = require('../../utils/ApiError');

async function createOrder(req, res, next) {
  try {
    const { leadId, amount } = createOrderSchema.parse(req.body);
    const result = await service.createOrder(leadId, req.user.id, amount);
    const message = result.alreadyPaid
      ? 'Payment already received for this escrow'
      : result.resumed
        ? 'Resuming your existing escrow order'
        : 'Escrow order created';
    created(res, result, message);
  } catch (err) { next(err); }
}

async function getEscrowById(req, res, next) {
  try {
    const escrow = await service.getById(req.params.id, req.user.id);
    success(res, escrow);
  } catch (err) { next(err); }
}

async function releaseEscrow(req, res, next) {
  try {
    const releaseData = releaseEscrowSchema.parse(req.body);
    const escrow = await service.release(req.params.id, req.user.id, releaseData, req.ip);
    success(res, escrow, 'Escrow released');
  } catch (err) { next(err); }
}

async function refundEscrow(req, res, next) {
  try {
    const escrow = await service.refund(req.params.id, req.user.id, req.ip);
    success(res, escrow, 'Escrow refunded');
  } catch (err) { next(err); }
}

async function getAllEscrow(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllEscrow(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getEscrowStats(req, res, next) {
  try {
    const stats = await service.getEscrowStats();
    success(res, stats);
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
    const escrow = await service.confirmPayment(razorpayOrderId, razorpayPaymentId, req.user.id);
    success(res, escrow, 'Payment verified');
  } catch (err) { next(err); }
}

module.exports = { createOrder, getEscrowById, verifyPayment, releaseEscrow, refundEscrow, getAllEscrow, getEscrowStats };
