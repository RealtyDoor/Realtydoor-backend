const { success, created, noContent } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./microsite.service');
const { createMicrositeSchema, updateMicrositeSchema } = require('./microsite.validator');

async function getBySlug(req, res, next) {
  try {
    const result = await service.getBySlug(req.params.slug.toLowerCase());
    success(res, result);
  } catch (err) { next(err); }
}

async function listForAdmin(req, res, next) {
  try {
    // Frontend reads one page, so the default (not just the ceiling)
    // needs to be 50 — parsePagination's own no-?limit-given default is
    // 20 (its maxLimit parameter only raises/lowers the CAP, not that
    // fallback), so it's pre-filled here rather than changing the shared
    // helper's default for every other admin list that relies on 20.
    const { page, limit, skip } = parsePagination({ ...req.query, limit: req.query.limit || '50' });
    const { data, total } = await service.listForAdmin(skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const data = createMicrositeSchema.parse(req.body);
    const microsite = await service.create(data, req.user.id, req.ip);
    created(res, microsite);
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const data = updateMicrositeSchema.parse(req.body);
    const microsite = await service.update(req.params.id, data, req.user.id, req.ip);
    success(res, microsite);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    await service.remove(req.params.id, req.user.id, req.ip);
    noContent(res);
  } catch (err) { next(err); }
}

module.exports = { getBySlug, listForAdmin, create, update, remove };
