const { success } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./listings.admin.service');
const { approveChangeRequestSchema, rejectChangeRequestSchema } = require('./listings.admin.validator');

// 4.8 — the review queue. Defaults to PENDING; ?status=ALL for history.
async function listChangeRequests(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listChangeRequests(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getChangeRequest(req, res, next) {
  try {
    success(res, await service.getChangeRequest(req.params.id));
  } catch (err) { next(err); }
}

// 4.9 — applies the diff to the live listing.
async function approveChangeRequest(req, res, next) {
  try {
    const { note, force } = approveChangeRequestSchema.parse(req.body);
    const result = await service.approveChangeRequest(
      req.params.id,
      { adminId: req.user.id, adminName: req.user.name, note, force },
      req.ip,
    );
    success(res, result, result.forcedOverConflicts.length
      ? `Applied ${result.appliedFields.length} change(s), overwriting later edits to ${result.forcedOverConflicts.join(', ')}`
      : `Applied ${result.appliedFields.length} change(s)`);
  } catch (err) { next(err); }
}

async function rejectChangeRequest(req, res, next) {
  try {
    const { note } = rejectChangeRequestSchema.parse(req.body);
    const cr = await service.rejectChangeRequest(req.params.id, { adminId: req.user.id, note }, req.ip);
    success(res, cr, 'Changes rejected');
  } catch (err) { next(err); }
}

// 4.12 / 4.13 — override history across every property.
async function listEditLogs(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listEditLogs(req.query, skip, limit);
    success(res, {
      ...paginate(data, total, page, limit),
      // Returned alongside the rows so a caller can see what the impact
      // filter actually means rather than inferring it.
      highImpactFields: service.HIGH_IMPACT_FIELDS,
    });
  } catch (err) { next(err); }
}

module.exports = {
  listChangeRequests, getChangeRequest, approveChangeRequest, rejectChangeRequest,
  listEditLogs,
};
