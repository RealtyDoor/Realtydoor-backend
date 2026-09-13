const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./admin.service');
const {
  assignLeadSchema,
  rejectPropertySchema,
  verifyKycSchema,
  updateLoanStatusSchema,
  changeUserRoleSchema,
  editPropertySchema,
  updateTicketSchema,
  createServiceSchema,
  updateServiceSchema,
  createTeamMemberSchema,
  updateTeamMemberSchema,
  verifyDocumentSchema,
  updateVideoTourSchema,
  createVendorSchema,
  updateVendorSchema,
  adminResolveDisputeSchema,
  moderateReviewSchema,
} = require('./admin.validator');
const disputeService = require('../disputes/disputes.service');
const reviewService  = require('../reviews/reviews.service');
const configService  = require('../config/config.service');
const { upsertConfigSchema } = require('../config/config.validator');

async function getLeadById(req, res, next) {
  try {
    const lead = await service.getLeadById(req.params.id);
    success(res, lead);
  } catch (err) { next(err); }
}

async function getLeads(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllLeads(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function assignLead(req, res, next) {
  try {
    const { partnerId } = assignLeadSchema.parse(req.body);
    const lead = await service.assignLead(req.params.id, partnerId, req.user.id, req.ip);
    success(res, lead, 'Lead assigned');
  } catch (err) { next(err); }
}

async function getPendingProperties(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getPendingProperties(skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function approveProperty(req, res, next) {
  try {
    const property = await service.approveProperty(req.params.id, req.user.id, req.ip);
    success(res, property, 'Property approved');
  } catch (err) { next(err); }
}

async function rejectProperty(req, res, next) {
  try {
    const { note } = rejectPropertySchema.parse(req.body);
    const property = await service.rejectProperty(req.params.id, note, req.user.id, req.ip);
    success(res, property, 'Property rejected');
  } catch (err) { next(err); }
}

async function getPendingKyc(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getPendingKyc(skip, limit, req.query.status);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function verifyKyc(req, res, next) {
  try {
    const { action, note } = verifyKycSchema.parse(req.body);
    const updated = await service.verifyKyc(req.params.userId, action, note, req.user.id, req.ip);
    success(res, updated, `KYC ${action === 'APPROVE' ? 'approved' : 'rejected'}`);
  } catch (err) { next(err); }
}

async function getRevenue(req, res, next) {
  try {
    const summary = await service.getRevenueSummary();
    success(res, summary);
  } catch (err) { next(err); }
}

async function getAuditLogs(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAuditLogs(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getPartnerMetrics(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getPartnerMetrics(skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getUsers(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllUsers(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function changeUserRole(req, res, next) {
  try {
    const { role } = changeUserRoleSchema.parse(req.body);
    const updated = await service.changeUserRole(req.params.id, role, req.user.id, req.ip);
    success(res, updated, `Role updated to ${role}`);
  } catch (err) { next(err); }
}

async function editProperty(req, res, next) {
  try {
    const data = editPropertySchema.parse(req.body);
    const property = await service.editProperty(
      req.params.id, data, req.user.id, req.user.name, req.ip,
    );
    success(res, property, 'Property updated');
  } catch (err) { next(err); }
}

async function getLoans(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllLoans(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function updateLoanStatus(req, res, next) {
  try {
    const { status, adminNote } = updateLoanStatusSchema.parse(req.body);
    const loan = await service.updateLoanStatus(req.params.id, status, adminNote, req.user.id);
    success(res, loan, 'Loan status updated');
  } catch (err) { next(err); }
}

async function suspendUser(req, res, next) {
  try {
    const { suspend, reason } = req.body;
    if (typeof suspend !== 'boolean') throw new ApiError(400, '"suspend" must be a boolean');
    const updated = await service.suspendUser(req.params.id, suspend, reason, req.user.id, req.ip);
    success(res, updated, suspend ? 'User suspended' : 'User unsuspended');
  } catch (err) { next(err); }
}

async function getTicket(req, res, next) {
  try {
    const ticket = await service.getTicketById(req.params.id);
    success(res, ticket);
  } catch (err) { next(err); }
}

async function getTickets(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getAllTickets(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function updateTicket(req, res, next) {
  try {
    const { status, vendorName, vendorPhone } = updateTicketSchema.parse(req.body);
    const ticket = await service.updateTicketStatus(req.params.id, status, vendorName, vendorPhone);
    success(res, ticket, 'Ticket updated');
  } catch (err) { next(err); }
}

async function getPropertyById(req, res, next) {
  try {
    const property = await service.getPropertyByIdAdmin(req.params.id);
    success(res, property);
  } catch (err) { next(err); }
}

async function getKycById(req, res, next) {
  try {
    const user = await service.getKycByUserId(req.params.userId);
    success(res, user);
  } catch (err) { next(err); }
}

async function getUserById(req, res, next) {
  try {
    const user = await service.getUserByIdAdmin(req.params.id);
    success(res, user);
  } catch (err) { next(err); }
}

async function listDocuments(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.adminListDocuments(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function verifyDocument(req, res, next) {
  try {
    const { action, note } = verifyDocumentSchema.parse(req.body);
    const doc = await service.adminVerifyDocument(req.params.id, action, note, req.user.id);
    success(res, doc, `Document ${action === 'APPROVE' ? 'approved' : 'rejected'}`);
  } catch (err) { next(err); }
}

async function listContactMessages(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listContactMessages(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function markContactRead(req, res, next) {
  try {
    const msg = await service.markContactRead(req.params.id);
    success(res, msg, 'Marked as read');
  } catch (err) { next(err); }
}

async function listNriLeads(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listNriLeads(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function markNriLeadRead(req, res, next) {
  try {
    const lead = await service.markNriLeadRead(req.params.id);
    success(res, lead, 'Marked as read');
  } catch (err) { next(err); }
}

async function listTeam(req, res, next) {
  try {
    const members = await service.adminListTeam();
    success(res, members);
  } catch (err) { next(err); }
}

async function createTeamMember(req, res, next) {
  try {
    const data = createTeamMemberSchema.parse(req.body);
    const member = await service.adminCreateTeamMember(data);
    created(res, member, 'Team member added');
  } catch (err) { next(err); }
}

async function updateTeamMember(req, res, next) {
  try {
    const data = updateTeamMemberSchema.parse(req.body);
    const member = await service.adminUpdateTeamMember(req.params.id, data);
    success(res, member, 'Team member updated');
  } catch (err) { next(err); }
}

async function deleteTeamMember(req, res, next) {
  try {
    await service.adminDeleteTeamMember(req.params.id);
    success(res, null, 'Team member removed');
  } catch (err) { next(err); }
}

async function getPartnerById(req, res, next) {
  try {
    const partner = await service.getPartnerById(req.params.id);
    success(res, partner);
  } catch (err) { next(err); }
}

async function listServices(req, res, next) {
  try {
    const services = await service.adminListServices();
    success(res, services);
  } catch (err) { next(err); }
}

async function createService(req, res, next) {
  try {
    const data = createServiceSchema.parse(req.body);
    const svc = await service.adminCreateService(data);
    created(res, svc, 'Service created');
  } catch (err) { next(err); }
}

async function updateService(req, res, next) {
  try {
    const data = updateServiceSchema.parse(req.body);
    const svc = await service.adminUpdateService(req.params.id, data);
    success(res, svc, 'Service updated');
  } catch (err) { next(err); }
}

async function deleteService(req, res, next) {
  try {
    await service.adminDeleteService(req.params.id);
    success(res, null, 'Service deactivated');
  } catch (err) { next(err); }
}

async function uploadVideoTourFile(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'Video file is required');
    const tour = await service.uploadVideoTourFile(req.params.id, req.file.path);
    success(res, tour, 'Video uploaded and tour marked completed');
  } catch (err) { next(err); }
}

async function listVideoTours(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listVideoTours(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function updateVideoTour(req, res, next) {
  try {
    const data = updateVideoTourSchema.parse(req.body);
    const tour = await service.updateVideoTour(req.params.id, data);
    success(res, tour, 'Video tour updated');
  } catch (err) { next(err); }
}

async function listVendors(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.adminListVendors(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function createVendor(req, res, next) {
  try {
    const data = createVendorSchema.parse(req.body);
    const vendor = await service.adminCreateVendor(data);
    created(res, vendor, 'Vendor added');
  } catch (err) { next(err); }
}

async function updateVendor(req, res, next) {
  try {
    const data = updateVendorSchema.parse(req.body);
    const vendor = await service.adminUpdateVendor(req.params.id, data);
    success(res, vendor, 'Vendor updated');
  } catch (err) { next(err); }
}

async function deleteVendor(req, res, next) {
  try {
    const vendor = await service.adminDeleteVendor(req.params.id);
    success(res, vendor, 'Vendor deactivated');
  } catch (err) { next(err); }
}

async function getAnalytics(req, res, next) {
  try {
    const analytics = await service.getAdminAnalytics();
    success(res, analytics);
  } catch (err) { next(err); }
}

async function listDisputes(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await disputeService.adminListDisputes(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function resolveDispute(req, res, next) {
  try {
    const data = adminResolveDisputeSchema.parse(req.body);
    const dispute = await disputeService.adminResolveDispute(req.params.id, data, req.user.id);
    success(res, dispute, 'Dispute updated');
  } catch (err) { next(err); }
}

async function listReviews(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await reviewService.adminListReviews(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function moderateReview(req, res, next) {
  try {
    const { action } = moderateReviewSchema.parse(req.body);
    const review = await reviewService.adminModerateReview(req.params.id, action, req.user.id);
    success(res, review, `Review ${action === 'APPROVE' ? 'approved' : 'rejected'}`);
  } catch (err) { next(err); }
}

async function listConfig(req, res, next) {
  try {
    const config = await configService.adminListConfig();
    success(res, config);
  } catch (err) { next(err); }
}

async function upsertConfig(req, res, next) {
  try {
    const data = upsertConfigSchema.parse(req.body);
    const entry = await configService.adminUpsertConfig(req.params.key, data, req.user.id);
    success(res, entry, 'Config updated');
  } catch (err) { next(err); }
}

async function deleteConfig(req, res, next) {
  try {
    await configService.adminDeleteConfig(req.params.key);
    success(res, null, 'Config key deleted');
  } catch (err) { next(err); }
}

module.exports = {
  getLeadById, getLeads, assignLead,
  getPendingProperties, approveProperty, rejectProperty, editProperty,
  getPendingKyc, verifyKyc,
  getRevenue, getAuditLogs, getPartnerMetrics,
  getTickets, getTicket, updateTicket,
  getLoans, updateLoanStatus,
  getUsers, changeUserRole, getUserById, suspendUser,
  getPartnerById,
  getPropertyById,
  getKycById,
  listDocuments, verifyDocument,
  listContactMessages, markContactRead,
  listNriLeads, markNriLeadRead,
  listTeam, createTeamMember, updateTeamMember, deleteTeamMember,
  listServices, createService, updateService, deleteService,
  listVideoTours, updateVideoTour, uploadVideoTourFile,
  listVendors, createVendor, updateVendor, deleteVendor,
  getAnalytics,
  listDisputes, resolveDispute,
  listReviews, moderateReview,
  listConfig, upsertConfig, deleteConfig,
};
