const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./commission.service');
const {
  createRateCardSchema, updateRateCardSchema, createOverrideSchema, setLeadTermsSchema,
  disputeCommissionSchema,
} = require('./commission.validator');

// ─── Rate cards (admin) ──────────────────────────────────────────────────────

async function listRateCards(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listRateCards(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function createRateCard(req, res, next) {
  try {
    const data = createRateCardSchema.parse(req.body);
    created(res, await service.createRateCard(data, req.user.id, req.ip), 'Rate card created');
  } catch (err) { next(err); }
}

async function updateRateCard(req, res, next) {
  try {
    const data = updateRateCardSchema.parse(req.body);
    success(res, await service.updateRateCard(req.params.id, data, req.user.id, req.ip), 'Rate card updated');
  } catch (err) { next(err); }
}

async function deleteRateCard(req, res, next) {
  try {
    success(res, await service.deleteRateCard(req.params.id, req.user.id, req.ip), 'Rate card deactivated');
  } catch (err) { next(err); }
}

// ─── Overrides (admin) ───────────────────────────────────────────────────────

async function listOverrides(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listOverrides(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function createOverride(req, res, next) {
  try {
    const data = createOverrideSchema.parse(req.body);
    created(res, await service.createOverride(data, req.user.id, req.ip), 'Override created');
  } catch (err) { next(err); }
}

async function revokeOverride(req, res, next) {
  try {
    success(res, await service.revokeOverride(req.params.id, req.user.id, req.ip), 'Override revoked');
  } catch (err) { next(err); }
}

// ─── Lead terms (admin) ──────────────────────────────────────────────────────

async function previewLeadTerms(req, res, next) {
  try {
    success(res, await service.previewTermsForLead(req.params.id));
  } catch (err) { next(err); }
}

async function getLeadTerms(req, res, next) {
  try {
    success(res, await service.getLeadTerms(req.params.id));
  } catch (err) { next(err); }
}

async function prefillLeadTerms(req, res, next) {
  try {
    success(res, await service.prefillLeadTerms(req.params.id, req.user.id, req.ip), 'Terms pre-filled from the rate card');
  } catch (err) { next(err); }
}

async function setLeadTerms(req, res, next) {
  try {
    const data = setLeadTermsSchema.parse(req.body);
    const result = await service.setLeadTerms(req.params.id, data, req.user.id, req.ip);
    success(res, result, result.locked ? 'Terms revised as a new version' : 'Terms saved');
  } catch (err) { next(err); }
}

async function lockLeadTerms(req, res, next) {
  try {
    success(res, await service.lockLeadTerms(req.params.id, req.user.id, req.ip), 'Terms locked');
  } catch (err) { next(err); }
}

async function leadTermsHistory(req, res, next) {
  try {
    success(res, await service.getLeadTermsHistory(req.params.id));
  } catch (err) { next(err); }
}

// ─── R26 — owner success-fee payment record + receipt (admin) ──────────────

async function invoiceLeadCommission(req, res, next) {
  try {
    success(res, await service.invoiceLeadCommission(req.params.id, req.user.id, req.ip), 'Invoice issued');
  } catch (err) { next(err); }
}

async function collectLeadCommission(req, res, next) {
  try {
    success(res, await service.collectLeadCommission(req.params.id, req.user.id, req.ip), 'Payment recorded as collected');
  } catch (err) { next(err); }
}

async function disputeLeadCommission(req, res, next) {
  try {
    const { reason } = disputeCommissionSchema.parse(req.body);
    success(res, await service.disputeLeadCommission(req.params.id, reason, req.user.id, req.ip), 'Marked as disputed');
  } catch (err) { next(err); }
}

// ─── B12.2 (partner) ─────────────────────────────────────────────────────────

async function myRateCards(req, res, next) {
  try {
    success(res, await service.getPartnerRateCards(req.user.id));
  } catch (err) { next(err); }
}

module.exports = {
  listRateCards, createRateCard, updateRateCard, deleteRateCard,
  listOverrides, createOverride, revokeOverride,
  previewLeadTerms, getLeadTerms, prefillLeadTerms, setLeadTerms, lockLeadTerms, leadTermsHistory,
  invoiceLeadCommission, collectLeadCommission, disputeLeadCommission,
  myRateCards,
};
