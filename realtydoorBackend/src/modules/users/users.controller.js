const { success, created } = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./users.service');
const {
  requestPhoneOtpSchema,
  verifyPhoneOtpSchema,
  toggleFavoriteSchema,
  uploadDocumentSchema,
  raiseTicketSchema,
  createLoanSchema,
  updateProfileSchema,
  requestVideoTourSchema,
  raiseDisputeSchema,
  rateLeadSchema,
  updateConsentSchema,
} = require('./users.validator');

async function requestPhoneOtp(req, res, next) {
  try {
    const { phone } = requestPhoneOtpSchema.parse(req.body);
    const result = await service.requestPhoneOtp(req.user.id, phone);
    success(res, result);
  } catch (err) { next(err); }
}

async function verifyPhoneOtp(req, res, next) {
  try {
    const { otp } = verifyPhoneOtpSchema.parse(req.body);
    const result = await service.verifyPhoneOtp(req.user.id, otp);
    success(res, result, 'Phone number verified');
  } catch (err) { next(err); }
}

async function getMyLeads(req, res, next) {
  try {
    const leads = await service.getMyLeads(req.user.id);
    success(res, leads);
  } catch (err) { next(err); }
}

async function rateLead(req, res, next) {
  try {
    const data = rateLeadSchema.parse(req.body);
    const lead = await service.rateLead(req.user.id, req.params.leadId, data);
    success(res, lead, 'Rating submitted');
  } catch (err) { next(err); }
}

async function updateConsent(req, res, next) {
  try {
    const data = updateConsentSchema.parse(req.body);
    const result = await service.updateConsent(req.user.id, data);
    success(res, result, 'Consent recorded');
  } catch (err) { next(err); }
}

async function toggleFavorite(req, res, next) {
  try {
    const { propertyId } = toggleFavoriteSchema.parse(req.body);
    const result = await service.toggleFavorite(req.user.id, propertyId);
    success(res, result);
  } catch (err) { next(err); }
}

async function getDocuments(req, res, next) {
  try {
    const docs = await service.getDocuments(req.user.id);
    success(res, docs);
  } catch (err) { next(err); }
}

async function uploadDocument(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'File is required');
    const { documentType } = uploadDocumentSchema.parse(req.body);
    const doc = await service.uploadDocument(req.user.id, documentType, req.file.path, req.file.originalname);
    created(res, doc, 'Document uploaded');
  } catch (err) { next(err); }
}

async function getSubscriptions(req, res, next) {
  try {
    const subs = await service.getSubscriptions(req.user.id);
    success(res, subs);
  } catch (err) { next(err); }
}

async function raiseTicket(req, res, next) {
  try {
    const data = raiseTicketSchema.parse(req.body);
    const ticket = await service.raiseTicket(req.user.id, data.subscriptionId, data);
    created(res, ticket, 'Ticket raised');
  } catch (err) { next(err); }
}

async function getMyTickets(req, res, next) {
  try {
    const tickets = await service.getMyTickets(req.user.id);
    success(res, tickets);
  } catch (err) { next(err); }
}

async function getMyTicketById(req, res, next) {
  try {
    const ticket = await service.getMyTicketById(req.user.id, req.params.id);
    success(res, ticket);
  } catch (err) { next(err); }
}

async function verifyTicket(req, res, next) {
  try {
    const ticket = await service.verifyTicket(req.user.id, req.params.id);
    success(res, ticket, 'Ticket verified and closed');
  } catch (err) { next(err); }
}

async function createLoanApplication(req, res, next) {
  try {
    const data = createLoanSchema.parse(req.body);
    const loan = await service.createLoanApplication(req.user.id, data);
    created(res, loan, 'Loan application submitted');
  } catch (err) { next(err); }
}

async function getMyLoanApplications(req, res, next) {
  try {
    const loans = await service.getMyLoanApplications(req.user.id);
    success(res, loans);
  } catch (err) { next(err); }
}

async function getLoanApplicationById(req, res, next) {
  try {
    const loan = await service.getLoanApplicationById(req.user.id, req.params.id);
    success(res, loan);
  } catch (err) { next(err); }
}

async function getFavorites(req, res, next) {
  try {
    const favs = await service.getFavorites(req.user.id);
    success(res, favs);
  } catch (err) { next(err); }
}

async function updateProfile(req, res, next) {
  try {
    const data = updateProfileSchema.parse(req.body);
    const profile = await service.updateProfile(req.user.id, data);
    success(res, profile, 'Profile updated');
  } catch (err) { next(err); }
}

async function requestVideoTour(req, res, next) {
  try {
    const { propertyId, userNote } = requestVideoTourSchema.parse(req.body);
    const tour = await service.requestVideoTour(req.user.id, propertyId, userNote);
    res.status(201).json({ success: true, data: tour, message: 'Video tour requested' });
  } catch (err) { next(err); }
}

async function getMyVideoTours(req, res, next) {
  try {
    const tours = await service.getMyVideoTours(req.user.id);
    success(res, tours);
  } catch (err) { next(err); }
}

async function raiseDispute(req, res, next) {
  try {
    const data = raiseDisputeSchema.parse(req.body);
    const dispute = await service.raiseDispute(req.user.id, data);
    created(res, dispute, 'Dispute raised');
  } catch (err) { next(err); }
}

async function getMyDisputes(req, res, next) {
  try {
    const disputes = await service.getMyDisputes(req.user.id);
    success(res, disputes);
  } catch (err) { next(err); }
}

module.exports = {
  requestPhoneOtp, verifyPhoneOtp, getMyLeads, rateLead, toggleFavorite, getFavorites, updateProfile,
  updateConsent,
  getDocuments, uploadDocument, getSubscriptions,
  raiseTicket, getMyTickets, getMyTicketById, verifyTicket,
  createLoanApplication, getMyLoanApplications, getLoanApplicationById,
  requestVideoTour, getMyVideoTours,
  raiseDispute, getMyDisputes,
};
