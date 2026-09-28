const { success, created } = require('../../utils/ApiResponse');
const { submitLeadSchema, scheduleVisitSchema, verifyOtpSchema, uploadDocsSchema, requestDropSchema } = require('./leads.validator');
const service = require('./leads.service');

async function submit(req, res, next) {
  try {
    const data = submitLeadSchema.parse(req.body);
    const lead = await service.submitLead(data, req.user.id);
    created(res, lead, "We'll reach out within 24 hours");
  } catch (err) { next(err); }
}

async function getMyLeads(req, res, next) {
  try {
    const leads = await service.getPartnerLeads(req.user.id);
    success(res, leads);
  } catch (err) { next(err); }
}

async function getLeadById(req, res, next) {
  try {
    const lead = await service.getPartnerLeadById(req.params.id, req.user.id);
    success(res, lead);
  } catch (err) { next(err); }
}

async function scheduleVisit(req, res, next) {
  try {
    const { scheduledAt } = scheduleVisitSchema.parse(req.body);
    const result = await service.scheduleVisit(req.params.id, req.user.id, scheduledAt);
    success(res, result);
  } catch (err) { next(err); }
}

async function resendOtp(req, res, next) {
  try {
    const result = await service.resendOtp(req.params.id, req.user.id);
    success(res, result);
  } catch (err) { next(err); }
}

async function requestOtpOverride(req, res, next) {
  try {
    const result = await service.requestOtpOverride(req.params.id, req.user.id);
    success(res, result);
  } catch (err) { next(err); }
}

async function verifyOtp(req, res, next) {
  try {
    const { otp } = verifyOtpSchema.parse(req.body);
    const result = await service.verifyOtp(req.params.id, req.user.id, otp);
    success(res, result);
  } catch (err) { next(err); }
}

async function uploadDocs(req, res, next) {
  try {
    const data = uploadDocsSchema.parse(req.body);
    const fileUrls = {
      visitPhotos: req.files?.visitPhotos?.map((f) => f.path) || [],
      closureDocs: req.files?.closureDocs?.map((f) => f.path) || [],
    };
    const lead = await service.uploadDocs(req.params.id, req.user.id, data, fileUrls);
    success(res, lead, 'Documentation uploaded');
  } catch (err) { next(err); }
}

async function closeLead(req, res, next) {
  try {
    const result = await service.closeLead(req.params.id, req.user.id);
    success(res, result);
  } catch (err) { next(err); }
}

async function requestDrop(req, res, next) {
  try {
    const { reason } = requestDropSchema.parse(req.body);
    const result = await service.requestDrop(req.params.id, req.user.id, reason);
    success(res, result);
  } catch (err) { next(err); }
}

async function approveDrop(req, res, next) {
  try {
    const lead = await service.adminApproveDrop(req.params.id, req.user.id, req.ip);
    success(res, lead, 'Lead dropped');
  } catch (err) { next(err); }
}

async function rejectDrop(req, res, next) {
  try {
    const result = await service.adminRejectDrop(req.params.id, req.user.id, req.ip);
    success(res, result, 'Drop request rejected');
  } catch (err) { next(err); }
}

module.exports = { submit, getMyLeads, getLeadById, scheduleVisit, resendOtp, requestOtpOverride, verifyOtp, uploadDocs, closeLead, requestDrop, approveDrop, rejectDrop };
