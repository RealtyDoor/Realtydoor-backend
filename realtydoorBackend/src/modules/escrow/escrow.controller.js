const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./escrow.service');
const { createOrderSchema, releaseEscrowSchema, freezeEscrowSchema } = require('./escrow.validator');
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

// Dev feedback, 2026-10-08 — the buyer's token-payment receipt, as a
// direct PDF download rather than the JSON envelope — same pattern as
// locality.controller.js's downloadReport.
async function getReceipt(req, res, next) {
  try {
    const pdfBuffer = await service.getReceipt(req.params.id, req.user.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="escrow-receipt-${req.params.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
}

// 2.8 / 2.9 — read-only: per-payee entitlements from the lead's locked
// commission lines, whether the held amount covers the fee, and which release
// conditions are unmet. Moves no money.
async function getReleasePlan(req, res, next) {
  try {
    success(res, await service.getReleasePlan(req.params.id));
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

// R10 — freeze / unfreeze for dispute.
async function freezeEscrow(req, res, next) {
  try {
    const { reason } = freezeEscrowSchema.parse(req.body);
    const escrow = await service.freeze(req.params.id, reason, req.user.id, req.ip);
    success(res, escrow, 'Escrow frozen');
  } catch (err) { next(err); }
}

async function unfreezeEscrow(req, res, next) {
  try {
    const escrow = await service.unfreeze(req.params.id, req.user.id, req.ip);
    success(res, escrow, 'Escrow unfrozen');
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

module.exports = {
  createOrder, getEscrowById, getReceipt, verifyPayment, getReleasePlan, releaseEscrow, refundEscrow, getAllEscrow, getEscrowStats,
  freezeEscrow, unfreezeEscrow,
};
