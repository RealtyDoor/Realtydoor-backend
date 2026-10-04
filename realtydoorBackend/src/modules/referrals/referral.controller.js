const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const { createReferralSchema, revokeReferralSchema, listReferralsSchema } = require('./referral.validator');
const service = require('./referral.service');

// ─── Partner (advisor) ───────────────────────────────────────────────────────

async function createMine(req, res, next) {
  try {
    const data = createReferralSchema.parse(req.body);
    const referral = await service.createReferral(req.user.id, data);
    created(res, referral, 'Referral recorded');
  } catch (err) { next(err); }
}

async function listMine(req, res, next) {
  try {
    const filters = listReferralsSchema.pick({ status: true }).parse(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listMyReferrals(req.user.id, filters, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function revokeMine(req, res, next) {
  try {
    const { reason } = revokeReferralSchema.parse(req.body);
    const referral = await service.revokeReferral(req.params.id, reason, null, req.ip, req.user.id);
    success(res, referral, 'Referral revoked');
  } catch (err) { next(err); }
}

// ─── Admin ───────────────────────────────────────────────────────────────────

async function listAdmin(req, res, next) {
  try {
    const filters = listReferralsSchema.parse(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listReferralsAdmin(filters, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function revokeAdmin(req, res, next) {
  try {
    const { reason } = revokeReferralSchema.parse(req.body);
    const referral = await service.revokeReferral(req.params.id, reason, req.user.id, req.ip);
    success(res, referral, 'Referral revoked');
  } catch (err) { next(err); }
}

module.exports = { createMine, listMine, revokeMine, listAdmin, revokeAdmin };
