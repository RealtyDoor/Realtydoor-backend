const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./escrow.service');
const payoutService = require('./escrowPayout.service');
const { createOrderSchema, releaseEscrowSchema, freezeEscrowSchema, refundEscrowSchema, retryPayoutSchema, resolvePayoutSchema, refundRemainingSchema, ESCROW_STATUSES } = require('./escrow.validator');
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

// Public: the numbers for "Booking this plot: token X + payment processing fee
// Y" before sign-in, and the refund terms. Reads settings only.
async function getCheckoutQuote(req, res, next) {
  try {
    const amount = Number(req.query.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, 'amount (rupees) is required');
    success(res, await service.getCheckoutQuote(amount));
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
async function getFeeInvoice(req, res, next) {
  try {
    const pdfBuffer = await service.getFeeInvoice(req.params.id, req.user.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="processing-fee-tax-invoice-${req.params.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
}

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
    const body = refundEscrowSchema.parse(req.body) ?? {};
    const escrow = await service.refund(req.params.id, req.user.id, req.ip, { reason: body.reason });
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

async function payPartnerCommission(req, res, next) {
  try {
    success(res, await service.payDeferredPartnerCommission(req.params.id, req.user.id, req.ip), 'Partner commission paid');
  } catch (err) { next(err); }
}

async function getAllEscrow(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    // BE-11 — req.query.status previously went straight to Prisma; an
    // unknown value (typo, stale FE code) threw a raw Prisma error that
    // surfaced as a 500 for the whole list instead of a clean 400.
    // Comma-separated values map to a Prisma `{ in: [...] }` filter.
    let statuses;
    if (req.query.status) {
      statuses = String(req.query.status).split(',').map((s) => s.trim());
      const invalid = statuses.filter((s) => !ESCROW_STATUSES.includes(s));
      if (invalid.length) {
        throw new ApiError(400, `Invalid status value(s): ${invalid.join(', ')}. Must be one of: ${ESCROW_STATUSES.join(', ')}`, { code: 'INVALID_STATUS' });
      }
    }
    const { data, total } = await service.getAllEscrow({ ...req.query, status: statuses }, skip, limit);
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

// BE-2 — read-only, live-fetched payout status for a HELD_PAYOUT_FAILED (or
// any released) escrow's legs.
async function getPayouts(req, res, next) {
  try {
    success(res, await payoutService.getPayouts(req.params.id));
  } catch (err) { next(err); }
}

async function retryPayout(req, res, next) {
  try {
    const body = retryPayoutSchema.parse(req.body);
    const escrow = await payoutService.retryPayout(req.params.id, body, req.user.id, req.ip);
    success(res, escrow, 'Payout retried');
  } catch (err) { next(err); }
}

async function resolvePayout(req, res, next) {
  try {
    const body = resolvePayoutSchema.parse(req.body);
    const escrow = await payoutService.resolvePayout(req.params.id, body, req.user.id, req.ip);
    success(res, escrow, 'Escrow marked resolved');
  } catch (err) { next(err); }
}

async function refundRemaining(req, res, next) {
  try {
    const { note } = refundRemainingSchema.parse(req.body);
    const escrow = await payoutService.refundRemaining(req.params.id, note, req.user.id, req.ip);
    success(res, escrow, 'Remaining amount refunded');
  } catch (err) { next(err); }
}

module.exports = {
  payPartnerCommission, getCheckoutQuote, createOrder, getEscrowById, getReceipt, getFeeInvoice, verifyPayment, getReleasePlan, releaseEscrow, refundEscrow, getAllEscrow, getEscrowStats,
  freezeEscrow, unfreezeEscrow, getPayouts, retryPayout, resolvePayout, refundRemaining,
};
