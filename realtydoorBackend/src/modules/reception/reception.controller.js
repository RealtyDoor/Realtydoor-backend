const { success, created } = require('../../utils/ApiResponse');
const { searchSchema, recordVisitSchema, myVisitsSchema, adminListSchema } = require('./reception.validator');
const service = require('./reception.service');

async function search(req, res, next) {
  try {
    const { q } = searchSchema.parse(req.query);
    success(res, await service.searchLeads(q));
  } catch (err) { next(err); }
}

async function recordVisit(req, res, next) {
  try {
    const data = recordVisitSchema.parse(req.body);
    const photoUrls = (req.files?.photos || []).map((f) => f.path);
    const result = await service.recordVisit(req.user, data, photoUrls, req.ip);
    created(res, result, result.codeVerified ? 'Visit recorded and marked done' : 'Visit recorded (not verified)');
  } catch (err) { next(err); }
}

async function myVisits(req, res, next) {
  try {
    const { day } = myVisitsSchema.parse(req.query);
    success(res, await service.myVisits(req.user.id, day));
  } catch (err) { next(err); }
}

async function adminList(req, res, next) {
  try {
    success(res, await service.adminList(adminListSchema.parse(req.query)));
  } catch (err) { next(err); }
}

module.exports = { search, recordVisit, myVisits, adminList };
