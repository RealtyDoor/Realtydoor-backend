const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./b2b.service');
const { expressInterestSchema, updateConnectionSchema } = require('./b2b.validator');

async function getFeed(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getFeed(req.user.id, req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getFeedCounts(req, res, next) {
  try {
    success(res, await service.getFeedCounts(req.user.id));
  } catch (err) { next(err); }
}

async function expressInterest(req, res, next) {
  try {
    const { message } = expressInterestSchema.parse(req.body ?? {});
    const conn = await service.expressInterest(req.user.id, req.params.propertyId, message);
    created(res, conn, 'Interest sent — the listing partner has been notified');
  } catch (err) { next(err); }
}

async function getMyConnections(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getMyConnections(req.user.id, req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function adminList(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.adminListConnections(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function adminUpdate(req, res, next) {
  try {
    const { status } = updateConnectionSchema.parse(req.body);
    const conn = await service.adminUpdateConnection(req.params.id, status, req.user.id);
    success(res, conn, `Connection marked ${status}`);
  } catch (err) { next(err); }
}

module.exports = { getFeed, getFeedCounts, expressInterest, getMyConnections, adminList, adminUpdate };
