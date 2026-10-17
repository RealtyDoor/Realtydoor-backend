const { success, created, noContent } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./cms.service');
const { createContentSchema, updateContentSchema, CONTENT_TYPES } = require('./cms.validator');
const ApiError = require('../../utils/ApiError');

async function getPublished(req, res, next) {
  try {
    const { type } = req.query;
    if (type && !CONTENT_TYPES.includes(type)) {
      throw new ApiError(400, `Invalid type. Must be one of: ${CONTENT_TYPES.join(', ')}`);
    }
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getPublished(type, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getBySlug(req, res, next) {
  try {
    const block = await service.getBySlug(req.params.slug);
    success(res, block);
  } catch (err) { next(err); }
}

async function getAllForAdmin(req, res, next) {
  try {
    const { type } = req.query;
    if (type && !CONTENT_TYPES.includes(type)) {
      throw new ApiError(400, `Invalid type. Must be one of: ${CONTENT_TYPES.join(', ')}`);
    }
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllForAdmin(type, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getByIdForAdmin(req, res, next) {
  try {
    const block = await service.getByIdForAdmin(req.params.id);
    success(res, block);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const data = createContentSchema.parse(req.body);
    const block = await service.create(data);
    created(res, block);
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const data = updateContentSchema.parse(req.body);
    const block = await service.update(req.params.id, data);
    success(res, block);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    await service.remove(req.params.id);
    noContent(res);
  } catch (err) { next(err); }
}

async function uploadImage(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'Image is required');
    const result = await service.uploadImage(req.file);
    success(res, result);
  } catch (err) { next(err); }
}

module.exports = { getPublished, getBySlug, getAllForAdmin, getByIdForAdmin, create, update, remove, uploadImage };
