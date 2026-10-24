const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const ApiError = require('../../utils/ApiError');
const service = require('./locality.service');
const { upsertLocalitySchema, suggestLocalitySchema, localityOptionsQuerySchema, correctSuggestionSchema } = require('./locality.validator');

async function getLocality(req, res, next) {
  try {
    const { city, locality } = req.query;
    if (!city || !locality) throw new ApiError(400, 'city and locality query params are required');
    const insight = await service.getLocality(city, locality);
    success(res, insight);
  } catch (err) { next(err); }
}

async function listOptions(req, res, next) {
  try {
    const { city } = localityOptionsQuerySchema.parse({ city: req.query.city });
    success(res, await service.listLocalityOptions(city));
  } catch (err) { next(err); }
}

async function suggest(req, res, next) {
  try {
    const data = suggestLocalitySchema.parse(req.body);
    const out = await service.suggestLocality(data, req.user);
    return out.created ? created(res, out) : success(res, out);
  } catch (err) { next(err); }
}

async function listSuggestions(req, res, next) {
  try { success(res, await service.listPendingSuggestions()); } catch (err) { next(err); }
}

async function correctSuggestion(req, res, next) {
  try {
    const { locality } = correctSuggestionSchema.parse(req.body);
    success(res, await service.correctSuggestion(req.params.id, locality, req.user.id), 'Locality corrected');
  } catch (err) { next(err); }
}

async function getLocalityPage(req, res, next) {
  try {
    const { city, locality } = req.query;
    if (!city || !locality) throw new ApiError(400, 'city and locality query params are required');
    const page = await service.getLocalityPage(city, locality);
    success(res, page);
  } catch (err) { next(err); }
}

async function downloadReport(req, res, next) {
  try {
    const { city, locality } = req.query;
    if (!city || !locality) throw new ApiError(400, 'city and locality query params are required');
    const pdfBuffer = await service.getLocalityReportPdf(city, locality);
    const filename = `${locality}-${city}-report.pdf`.replace(/[^a-z0-9.-]+/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
}

async function listLocalities(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { city } = req.query;
    const { data, total } = await service.listLocalities({ city }, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getLocalityById(req, res, next) {
  try {
    const insight = await service.getLocalityById(req.params.id);
    success(res, insight);
  } catch (err) { next(err); }
}

async function upsertLocality(req, res, next) {
  try {
    const data = upsertLocalitySchema.parse(req.body);
    const insight = await service.upsertLocality(data, req.user.id);
    created(res, insight, 'Locality insight saved');
  } catch (err) { next(err); }
}

async function deleteLocality(req, res, next) {
  try {
    await service.deleteLocality(req.params.id);
    success(res, null, 'Locality insight deleted');
  } catch (err) { next(err); }
}

async function getCitiesSummary(req, res, next) {
  try {
    const summary = await service.getCitiesSummary();
    success(res, summary);
  } catch (err) { next(err); }
}

async function getLocalitiesList(req, res, next) {
  try {
    const { city } = req.query;
    const data = await service.getLocalitiesList(city);
    success(res, data);
  } catch (err) { next(err); }
}

module.exports = {
  correctSuggestion,
  getLocality, getLocalityPage, listLocalities, getLocalityById, upsertLocality, deleteLocality,
  getCitiesSummary, downloadReport, getLocalitiesList, listOptions, suggest, listSuggestions,
};
