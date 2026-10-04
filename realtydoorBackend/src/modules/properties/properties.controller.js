const { success, created } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/pagination');
const { searchSchema, createPropertySchema, reportUnauthorizedListingSchema } = require('./properties.validator');
const service = require('./properties.service');
const ApiError = require('../../utils/ApiError');

async function search(req, res, next) {
  try {
    const query = searchSchema.parse(req.query);
    const { page, limit, skip } = parsePagination(query);
    const result = await service.searchProperties(query, skip, limit, page);
    success(res, result);
  } catch (err) { next(err); }
}

async function getBySlug(req, res, next) {
  try {
    const property = await service.getPropertyBySlug(req.params.slug);
    success(res, property);
  } catch (err) { next(err); }
}

async function getFeatured(req, res, next) {
  try {
    const properties = await service.getFeaturedProperties();
    success(res, properties);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const data = createPropertySchema.parse(req.body);
    const property = await service.createProperty(data, req.user.id);
    res.status(201).json({ success: true, message: 'Listing submitted for review', data: property });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const data = createPropertySchema.partial().parse(req.body);
    // 4.8 — editing a LIVE listing returns the unchanged property plus the
    // pending changeRequest, not an updated property. The listing stays live
    // until an admin reviews the diff, so callers must read `changeRequest`
    // rather than assuming `property` reflects what they just sent.
    const { property, changeRequest, message } = await service.updateProperty(req.params.id, req.user.id, data);
    success(res, { property, changeRequest }, message);
  } catch (err) { next(err); }
}

async function uploadImages(req, res, next) {
  try {
    const urls = (req.files || []).map(f => f.path);
    if (!urls.length) throw new ApiError(400, 'No images provided');
    const property = await service.addImages(req.params.id, req.user.id, urls);
    success(res, property, 'Images uploaded');
  } catch (err) { next(err); }
}

async function uploadVideos(req, res, next) {
  try {
    const urls = (req.files || []).map(f => f.path);
    if (!urls.length) throw new ApiError(400, 'No videos provided');
    const property = await service.addVideos(req.params.id, req.user.id, urls);
    success(res, property, 'Videos uploaded');
  } catch (err) { next(err); }
}

async function uploadDocuments(req, res, next) {
  try {
    const files = req.files || [];
    if (!files.length) throw new ApiError(400, 'No documents provided');
    const property = await service.addDocuments(req.params.id, req.user.id, files);
    success(res, property, 'Documents uploaded');
  } catch (err) { next(err); }
}

async function getEditLogs(req, res, next) {
  try {
    const logs = await service.getPropertyEditLogs(req.params.id, req.user.id);
    success(res, logs);
  } catch (err) { next(err); }
}

async function getConstructionUpdates(req, res, next) {
  try {
    const updates = await service.getConstructionUpdates(req.params.id);
    success(res, updates);
  } catch (err) { next(err); }
}

async function addConstructionUpdate(req, res, next) {
  try {
    const { constructionUpdateSchema } = require('./properties.validator');
    const data = constructionUpdateSchema.parse(req.body);
    const update = await service.addConstructionUpdate(req.params.id, req.user.id, data);
    res.status(201).json({ success: true, data: update });
  } catch (err) { next(err); }
}

// R27 — public (no auth): the real owner may have no RealtyDoor account.
async function reportUnauthorizedListing(req, res, next) {
  try {
    const data = reportUnauthorizedListingSchema.parse(req.body);
    const result = await service.reportUnauthorizedListing(req.params.id, data);
    created(res, result, 'Report received. Our team will review this listing.');
  } catch (err) { next(err); }
}

module.exports = {
  search, getBySlug, getFeatured, create, update, uploadImages, uploadVideos, uploadDocuments, getEditLogs,
  getConstructionUpdates, addConstructionUpdate, reportUnauthorizedListing,
};
