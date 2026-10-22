const { success, created } = require('../../utils/ApiResponse');
const { isTrustedMediaUrl } = require('../../lib/trustedUrl');
const { parsePagination } = require('../../utils/pagination');
const { searchSchema, createPropertySchema, missingPriceMessage, reportUnauthorizedListingSchema } = require('./properties.validator');
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
    const property = await service.getPropertyByIdOrSlug(req.params.slug);
    success(res, property);
  } catch (err) { next(err); }
}

// GET /api/properties/:slug/brochure. The property's own brochure (uploaded or imported) if it has one,
// otherwise a PDF generated from the listing, so every listed property has a brochure.
async function getBrochure(req, res, next) {
  try {
    const property = await service.getPropertyByIdOrSlug(req.params.slug);
    // Only a brochure stored on our own storage is linked to; a partner-supplied link elsewhere would make this an open redirect.
    const stored = (property.documents || []).find((d) => d && isTrustedMediaUrl(d.url) && /brochure/i.test(d.name || ''));
    if (stored) return res.redirect(302, stored.url);
    const { buildPropertyBrochurePdf } = require('../../lib/propertyBrochure');
    const pdf = await buildPropertyBrochurePdf(property, (process.env.FRONTEND_URL || '').replace(/\/$/, '') || undefined);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${property.slug || 'property'}-brochure.pdf"`,
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(pdf);
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
    const priceProblem = missingPriceMessage(data);
    if (priceProblem) throw new ApiError(400, priceProblem);
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
  search, getBySlug, getBrochure, getFeatured, create, update, uploadImages, uploadVideos, uploadDocuments, getEditLogs,
  getConstructionUpdates, addConstructionUpdate, reportUnauthorizedListing,
};
