const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const {
  createBuilderInvoiceSchema, disputeBuilderInvoiceSchema, listBuilderInvoicesSchema,
} = require('./builderInvoice.validator');
const service = require('./builderInvoice.service');

// ─── Admin ───────────────────────────────────────────────────────────────────

async function createInvoice(req, res, next) {
  try {
    const { unitId } = createBuilderInvoiceSchema.parse(req.body);
    created(res, await service.createInvoice(unitId, req.user.id, req.ip), 'Invoice issued');
  } catch (err) { next(err); }
}

async function collectInvoice(req, res, next) {
  try {
    success(res, await service.collectInvoice(req.params.id, req.user.id, req.ip), 'Payment recorded as collected');
  } catch (err) { next(err); }
}

async function disputeInvoice(req, res, next) {
  try {
    const { reason } = disputeBuilderInvoiceSchema.parse(req.body);
    success(res, await service.disputeInvoice(req.params.id, reason, req.user.id, req.ip), 'Marked as disputed');
  } catch (err) { next(err); }
}

async function listAdmin(req, res, next) {
  try {
    const filters = listBuilderInvoicesSchema.parse(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listInvoicesAdmin(filters, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

// ─── Partner (builder) ───────────────────────────────────────────────────────

async function listMine(req, res, next) {
  try {
    const filters = listBuilderInvoicesSchema.pick({ status: true }).parse(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listMyInvoices(req.user.id, filters, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

module.exports = { createInvoice, collectInvoice, disputeInvoice, listAdmin, listMine };
