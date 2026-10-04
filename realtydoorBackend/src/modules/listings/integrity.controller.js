const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./integrity.service');
const {
  createMandateSchema, revokeMandateSchema, resolveConflictSchema,
} = require('./integrity.validator');

// ─── 4.3 — mandates ──────────────────────────────────────────────────────────

async function createMandate(req, res, next) {
  try {
    const data = createMandateSchema.parse(req.body);
    const result = await service.createMandate(req.params.id, data, req.user.id, req.ip);
    created(res, result, result.conflicts.length
      ? `Mandate created; ${result.conflicts.length} conflict(s) detected`
      : 'Mandate created');
  } catch (err) { next(err); }
}

async function listMandates(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listMandates(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getMandate(req, res, next) {
  try {
    success(res, await service.getMandate(req.params.id));
  } catch (err) { next(err); }
}

async function revokeMandate(req, res, next) {
  try {
    const { reason } = revokeMandateSchema.parse(req.body);
    const m = await service.revokeMandate(req.params.id, reason, req.user.id, req.ip);
    success(res, m, 'Mandate revoked');
  } catch (err) { next(err); }
}

// ─── 4.4 — conflicts ─────────────────────────────────────────────────────────

async function detectConflicts(req, res, next) {
  try {
    const conflicts = await service.detectConflicts(req.params.id);
    success(res, { detected: conflicts.length, conflicts }, conflicts.length
      ? `${conflicts.length} new conflict(s) detected`
      : 'No new conflicts detected');
  } catch (err) { next(err); }
}

async function listConflicts(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listConflicts(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function resolveConflict(req, res, next) {
  try {
    const { status, resolution } = resolveConflictSchema.parse(req.body);
    const c = await service.resolveConflict(
      req.params.id, { status, resolution, adminId: req.user.id }, req.ip,
    );
    success(res, c, `Conflict ${status.toLowerCase()}`);
  } catch (err) { next(err); }
}

module.exports = {
  createMandate, listMandates, getMandate, revokeMandate,
  detectConflicts, listConflicts, resolveConflict,
};
