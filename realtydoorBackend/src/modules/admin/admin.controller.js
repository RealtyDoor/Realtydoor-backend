const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./admin.service');
const {
  assignLeadSchema,
  createLeadSchema,
  confirmLeadSchema,
  rejectLeadSchema,
  rejectPropertySchema,
  verifyKycSchema,
  updateLoanStatusSchema,
  changeUserRoleSchema,
  editPropertySchema,
  approvePropertySchema,
  requestPropertyChangesSchema,
  requestKycDocumentsSchema,
  updateTicketSchema,
  dispatchTicketSchema,
  resolveTicketSchema,
  linkTicketToDealSchema,
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
const partnerService = require('../partners/partners.service');
const { setPayoutStatusSchema } = require('../partners/partners.validator');
const ApiError = require('../../utils/ApiError');

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

// Auto-assign: the backend picks the partner instead of the admin naming one.
async function autoAssignLead(req, res, next) {
  try {
    const result = await service.autoAssignLead(req.params.id, req.user.id, req.ip);
    success(res, result, `Assigned to ${result.assignedTo.companyName || result.assignedTo.name}`);
  } catch (err) { next(err); }
}

async function autoAssignUnassignedLeads(req, res, next) {
  try {
    const result = await service.autoAssignUnassignedLeads(req.query, req.user.id, req.ip);
    success(res, result, `${result.assignedCount} of ${result.totalConsidered} lead(s) assigned`);
  } catch (err) { next(err); }
}

async function createLead(req, res, next) {
  try {
    const data = createLeadSchema.parse(req.body);
    const lead = await service.createLead(data, req.user.id, req.ip);
    created(res, lead, 'Lead created');
  } catch (err) { next(err); }
}

async function confirmLead(req, res, next) {
  try {
    const { partnerId } = confirmLeadSchema.parse(req.body ?? {});
    const lead = await service.confirmLead(req.params.id, partnerId, req.user.id, req.ip);
    success(res, lead, 'Lead confirmed');
  } catch (err) { next(err); }
}

async function rejectLead(req, res, next) {
  try {
    const { reason } = rejectLeadSchema.parse(req.body);
    const lead = await service.rejectLead(req.params.id, reason, req.user.id, req.ip);
    success(res, lead, 'Lead rejected');
  } catch (err) { next(err); }
}

async function overrideLeadOtp(req, res, next) {
  try {
    const { note } = req.body ?? {};
    const result = await service.overrideLeadOtp(req.params.id, req.user.id, req.ip, note);
    success(res, result, 'OTP unlocked and a fresh code sent to the buyer');
  } catch (err) { next(err); }
}

// 3.5 — admin side of the payout-account clarification flow.
async function setPayoutAccountStatus(req, res, next) {
  try {
    const { status, note } = setPayoutStatusSchema.parse(req.body);
    const result = await partnerService.setPayoutAccountStatus(req.params.id, status, note, req.user.id, req.ip);
    success(res, result, `Payout account marked ${status}`);
  } catch (err) { next(err); }
}

// R14 — every partner's payout account in one view, not a one-at-a-time
// status-setter with nothing to list from.
async function listPayoutAccounts(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await partnerService.listPayoutAccounts(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getPendingProperties(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getPendingProperties(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function approveProperty(req, res, next) {
  try {
    // 4.14 — body is optional; omitting it approves as public + searchable,
    // not featured, which is what approving did before this existed.
    const { visibility } = approvePropertySchema.parse(req.body ?? {});
    const property = await service.approveProperty(req.params.id, req.user.id, req.ip, visibility || {});
    const where = ['public'];
    if (property.isSearchable) where.push('search');
    if (property.isFeatured) where.push('homepage');
    success(res, property, `Property approved (visible in: ${where.join(', ')})`);
  } catch (err) { next(err); }
}

// 4.15 — ask for specific fixes without rejecting the listing.
// R9 — ask for specific KYC documents instead of rejecting.
async function requestKycDocuments(req, res, next) {
  try {
    const { items, note, dueInDays } = requestKycDocumentsSchema.parse(req.body);
    const user = await service.requestKycDocuments(
      req.params.userId, { items, note, dueInDays }, req.user.id, req.ip,
    );
    success(res, user, `Requested ${items.length} document(s)`);
  } catch (err) { next(err); }
}

async function requestPropertyChanges(req, res, next) {
  try {
    const { items, note } = requestPropertyChangesSchema.parse(req.body);
    const property = await service.requestPropertyChanges(
      req.params.id, { items, note }, req.user.id, req.user.name, req.ip,
    );
    success(res, property, `Requested ${items.length} change(s)`);
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
    const { status, adminNote, ...extraFields } = updateLoanStatusSchema.parse(req.body);
    const loan = await service.updateLoanStatus(req.params.id, status, adminNote, req.user.id, extraFields);
    success(res, loan, 'Loan status updated');
  } catch (err) { next(err); }
}

async function getLoanBankStats(req, res, next) {
  try {
    const stats = await service.getLoanBankStats();
    success(res, stats);
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

async function getTicketStats(req, res, next) {
  try {
    const stats = await service.getTicketStats();
    success(res, stats);
  } catch (err) { next(err); }
}

// 7.2 / 7.9 — dispatch a vendor (or reassign, by calling again with a
// different vendorId).
async function dispatchTicket(req, res, next) {
  try {
    const data = dispatchTicketSchema.parse(req.body);
    const ticket = await service.dispatchTicket(req.params.id, data, req.user.id, req.ip);
    success(res, ticket, 'Vendor dispatched');
  } catch (err) { next(err); }
}

// 7.4 / 7.5
async function resolveTicket(req, res, next) {
  try {
    const data = resolveTicketSchema.parse(req.body);
    const ticket = await service.resolveTicket(req.params.id, data, req.user.id, req.ip);
    success(res, ticket, 'Ticket resolved');
  } catch (err) { next(err); }
}

// 7.8
async function linkTicketToDeal(req, res, next) {
  try {
    const { leadId } = linkTicketToDealSchema.parse(req.body);
    const ticket = await service.linkTicketToDeal(req.params.id, leadId, req.user.id, req.ip);
    success(res, ticket, 'Ticket linked to deal');
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
    const { data, total, statusCounts } = await service.listContactMessages(req.query, skip, limit);
    // statusCounts rides alongside the pagination envelope so the inbox tabs
    // get their badges without a second request.
    success(res, { ...paginate(data, total, page, limit), statusCounts });
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

// 7.1 — rating + jobsCount, not on the plain list row shape.
async function getVendor(req, res, next) {
  try {
    const vendor = await service.getVendorById(req.params.id);
    success(res, vendor);
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
  getLeadById, getLeads, assignLead, autoAssignLead, autoAssignUnassignedLeads, createLead, confirmLead, rejectLead, overrideLeadOtp,
  setPayoutAccountStatus, listPayoutAccounts,
  getPendingProperties, approveProperty, rejectProperty, editProperty,
  requestPropertyChanges,
  requestKycDocuments,
  getPendingKyc, verifyKyc,
  getRevenue, getAuditLogs, getPartnerMetrics,
  getTickets, getTicket, updateTicket, getTicketStats,
  dispatchTicket, resolveTicket, linkTicketToDeal,
  getLoans, updateLoanStatus, getLoanBankStats,
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
  listVendors, getVendor, createVendor, updateVendor, deleteVendor,
  getAnalytics,
  listDisputes, resolveDispute,
  listReviews, moderateReview,
  listConfig, upsertConfig, deleteConfig,
};
