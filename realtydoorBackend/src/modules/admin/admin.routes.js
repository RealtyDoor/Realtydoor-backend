const router = require('express').Router();
const ctrl = require('./admin.controller');
const escrowCtrl = require('../escrow/escrow.controller');
const cmsCtrl = require('../cms/cms.controller');
const notifCtrl = require('../notifications/notifications.controller');
const leadsCtrl = require('../leads/leads.controller');
const watiCtrl = require('../wati/wati.controller');
const b2bCtrl = require('../b2b/b2b.controller');
const contactCtrl = require('../contact/contact.admin.controller');
const commissionCtrl = require('../commission/commission.controller');
const referralCtrl = require('../referrals/referral.controller');
const analyticsCtrl = require('../analytics/analytics.controller');
const listingCtrl = require('../listings/listings.admin.controller');
const integrityCtrl = require('../listings/integrity.controller');
const locationCtrl = require('../listings/location.controller');
const checklistCtrl = require('../listings/checklist.controller');
const projectCtrl = require('../projects/project.controller');
const builderInvoiceCtrl = require('../projects/builderInvoice.controller');
const micrositeCtrl = require('../microsites/microsite.controller');
const partnerTicketCtrl = require('../partners/partnerTicket.admin.controller');
const onboardingCtrl = require('../onboarding/onboarding.controller');
const leadSalesCtrl = require('../leadSales/leadSales.controller');
const leadIntakeCtrl = require('../leadIntake/leadIntake.controller');
const whatsappInboxCtrl = require('../wati/whatsappInbox.controller');
const { authenticate } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireRole');
const { requirePermission } = require('../../middleware/requirePermission');
const { restrictSalesOnly } = require('../../middleware/salesOnly');
const { perUserLimiter } = require('../../middleware/rateLimiter');
const { validateObjectId } = require('../../middleware/validateObjectId');
const { videoTourUploader, onboardingDocUploader, buildMulter, IMAGE_FORMATS } = require('../../lib/fileUpload');
const { auditAction } = require('../../middleware/auditAction');

// T45 — a vendor is never hard-deleted (DELETE only deactivates), so the audit
// log says what actually happened.
const vendorPatchAction = (req) => (
  req.body?.isActive === false ? 'VENDOR_DEACTIVATED'
    : req.body?.isActive === true ? 'VENDOR_REACTIVATED'
      : 'VENDOR_UPDATED'
);
const ApiError = require('../../utils/ApiError');

// CMS image upload — a bare `multer()` instance (not the buildUploader()
// factory the other uploaders use), per the spec: no S3 folder is implied
// by a route/entity here, since this must work for an unsaved blog post
// (no post id yet to hang the upload off of). multer's own errors (a
// rejected file type from buildMulter's fileFilter, or the 10MB
// LIMIT_FILE_SIZE) are plain Errors/MulterErrors, not ApiError — left
// alone, they'd hit errorHandler.js's generic 500 INTERNAL_ERROR path
// instead of the clean, readable 400 the spec calls for.
const contentImageUpload = buildMulter(IMAGE_FORMATS, 10);
function uploadContentImageMiddleware(req, res, next) {
  contentImageUpload.single('image')(req, res, (err) => {
    if (err) return next(new ApiError(400, err.message));
    next();
  });
}

router.use(authenticate, requireAdmin, perUserLimiter);
router.use(restrictSalesOnly); // a sales-only BDE reaches only the lead routes (middleware/salesOnly.js)

// Lead management
router.get('/leads', requirePermission(['LEADS', 'SALES']), ctrl.getLeads);
router.post('/leads',       requirePermission('LEADS'), ctrl.createLead);          // 6.4a — admin logs an off-platform lead
// Auto-assign: static path, registered above /leads/:id so it is never
// swallowed as a lead id.
router.post('/leads/auto-assign', requirePermission('LEADS'), ctrl.autoAssignUnassignedLeads);
// backend-work-still-open.md #7 — admin-named partner/vendor overrides,
// consulted by leads' auto-assign above and tickets' auto-dispatch below.
router.get('/routing-rules', requirePermission('LEADS'), ctrl.listRoutingRules);
router.post('/routing-rules',     requirePermission('LEADS'), ctrl.createRoutingRule);
router.patch('/routing-rules/:id', requirePermission('LEADS'), ctrl.updateRoutingRule);
router.delete('/routing-rules/:id', requirePermission('LEADS'), ctrl.deleteRoutingRule);
// Sales (BDE) layer on a lead: qualification stage, temperature, owner, follow-ups, note history. Static paths come before /leads/:id.
// A BDE (SALES without LEADS) only ever sees and changes the leads they own; export and setting owners are for managers (LEADS).
router.get('/leads/sales-summary',    requirePermission(['LEADS', 'SALES']), leadSalesCtrl.salesSummary);
router.get('/leads/owners',           requirePermission(['LEADS', 'SALES']), leadSalesCtrl.owners);
router.get('/leads/export',           requirePermission('LEADS'), leadSalesCtrl.exportLeads);
router.get('/leads/:id/notes',        validateObjectId('id'), requirePermission(['LEADS', 'SALES']), leadSalesCtrl.listNotes);
router.post('/leads/:id/notes',       validateObjectId('id'), requirePermission(['LEADS', 'SALES']), leadSalesCtrl.addNote);
router.patch('/leads/:id/sales',      validateObjectId('id'), requirePermission(['LEADS', 'SALES']), leadSalesCtrl.updateSales);
router.patch('/leads/:id/do-not-contact', validateObjectId('id'), requirePermission('LEADS'), ctrl.setDoNotContact); // the buyer asked not to be contacted
router.get('/leads/:id/related', validateObjectId('id'), requirePermission('LEADS'), ctrl.getRelatedLeads); // other leads for the same buyer (same mobile number)
router.get('/leads/:id', requirePermission(['LEADS', 'SALES']), ctrl.getLeadById);
router.patch('/leads/:id/assign',        requirePermission('LEADS'), ctrl.assignLead);
router.post('/leads/:id/auto-assign',    requirePermission('LEADS'), ctrl.autoAssignLead);
// 6.3 — vet a partner-added (AWAITING_ADMIN) lead. Confirm optionally assigns
// in one step; passing a different partnerId is the reassign case.
router.patch('/leads/:id/confirm',       requirePermission('LEADS'), ctrl.confirmLead);
router.patch('/leads/:id/reject',        requirePermission('LEADS'), ctrl.rejectLead);
router.patch('/leads/:id/details',       validateObjectId('id'), requirePermission('LEADS'), ctrl.updateLeadDetails);
router.patch('/leads/:id/note',          requirePermission('LEADS'), validateObjectId('id'), ctrl.setLeadNote);
// 6.6 — clear a locked site-visit OTP and issue a fresh code to the buyer.
router.patch('/leads/:id/otp-override',  requirePermission('LEADS'), ctrl.overrideLeadOtp);
router.patch('/leads/:id/approve-drop',  requirePermission('LEADS'), leadsCtrl.approveDrop);
router.patch('/leads/:id/reject-drop',   requirePermission('LEADS'), leadsCtrl.rejectDrop);
router.patch('/leads/:id/approve-hold-extension', requirePermission('LEADS'), leadsCtrl.approveHoldExtension);
router.patch('/leads/:id/decline-hold-extension', requirePermission('LEADS'), leadsCtrl.declineHoldExtension);
// Lead integrations (Instagram, Google Ads, WhatsApp, website, webhooks): connect a source, map its forms to projects, see what arrived.
router.get('/lead-integrations',                                 requirePermission('LEADS'), leadIntakeCtrl.list);
router.post('/lead-integrations',                                requirePermission('LEADS'), leadIntakeCtrl.create);
router.patch('/lead-integrations/:id',            validateObjectId('id'), requirePermission('LEADS'), leadIntakeCtrl.update);
router.post('/lead-integrations/:id/rotate-secret', validateObjectId('id'), requirePermission('LEADS'), leadIntakeCtrl.rotate);
router.post('/lead-integrations/:id/test',        validateObjectId('id'), requirePermission('LEADS'), leadIntakeCtrl.test);
router.get('/lead-integrations/:id/events',       validateObjectId('id'), requirePermission('LEADS'), leadIntakeCtrl.events);
router.post('/lead-integrations/:id/mappings',    validateObjectId('id'), requirePermission('LEADS'), leadIntakeCtrl.addMapping);
router.delete('/lead-integrations/:id/mappings/:mappingId', validateObjectId('id'), validateObjectId('mappingId'), requirePermission('LEADS'), leadIntakeCtrl.deleteMapping);
router.patch('/leads/:id/confirm-no-show', requirePermission('LEADS'), leadsCtrl.confirmNoShow);
router.patch('/leads/:id/release-registration', requirePermission('LEADS'), leadsCtrl.releaseRegistration);
router.patch('/leads/:id/allocation-letter/verify', validateObjectId('id'), requirePermission('FINANCE'), leadsCtrl.verifyAllocationLetter);

// Property approval + admin edit
router.get('/properties', requirePermission('LISTINGS'), ctrl.getPendingProperties);
// 4.8 / 4.9 / 4.12 / 4.13 — these sit ABOVE /properties/:id deliberately.
// Express matches in order, so registering them after the param route would
// make :id swallow "change-requests" and "edit-logs" as property ids.
router.get('/properties/change-requests', requirePermission('LISTINGS'), listingCtrl.listChangeRequests);
router.get('/properties/change-requests/:id', requirePermission('LISTINGS'), listingCtrl.getChangeRequest);
router.patch('/properties/change-requests/:id/approve', requirePermission('LISTINGS'), listingCtrl.approveChangeRequest);
router.patch('/properties/change-requests/:id/reject',  requirePermission('LISTINGS'), listingCtrl.rejectChangeRequest);
router.get('/properties/edit-logs', requirePermission('LISTINGS'), listingCtrl.listEditLogs);
// 4.3 / 4.4 — mandates and conflict detection. Static segments stay above the
// /properties/:id param route for the same reason as the change-request ones.
router.get('/properties/mandates', requirePermission('LISTINGS'), integrityCtrl.listMandates);
router.get('/properties/mandates/:id', requirePermission('LISTINGS'), integrityCtrl.getMandate);
router.patch('/properties/mandates/:id/revoke',      requirePermission('LISTINGS'), integrityCtrl.revokeMandate);
router.get('/properties/conflicts', requirePermission('LISTINGS'), integrityCtrl.listConflicts);
router.patch('/properties/conflicts/:id/resolve',    requirePermission('LISTINGS'), integrityCtrl.resolveConflict);
router.post('/properties/:id/mandates',              requirePermission('LISTINGS'), integrityCtrl.createMandate);
router.post('/properties/:id/detect-conflicts',      requirePermission('LISTINGS'), integrityCtrl.detectConflicts);
// 4.6 / 4.7 — location check and admin location edit.
router.get('/properties/:id/location-check', requirePermission('LISTINGS'), locationCtrl.locationCheck);
router.patch('/properties/:id/location',              requirePermission('LISTINGS'), locationCtrl.updateLocation);
// 4.1 / 4.2 — persona document checklist and owner-confirmation review.
router.get('/properties/:id/checklist', requirePermission('LISTINGS'), checklistCtrl.getChecklist);
router.patch('/properties/checklist-documents/:docId/verify', requirePermission('LISTINGS'), checklistCtrl.verifyChecklistDocument);
router.patch('/properties/checklist-documents/:docId/reject', requirePermission('LISTINGS'), checklistCtrl.rejectChecklistDocument);
router.post('/properties/:id/mandates/:mandateId/owner-confirmation/request', requirePermission('LISTINGS'), checklistCtrl.requestOwnerConfirmation);
router.patch('/properties/owner-confirmation/:confirmationId', requirePermission('LISTINGS'), checklistCtrl.recordOwnerConfirmation);
router.get('/properties/:id', requirePermission('LISTINGS'), ctrl.getPropertyById);
router.patch('/properties/:id/approve', requirePermission('LISTINGS'), ctrl.approveProperty);
router.patch('/properties/:id/reject',  requirePermission('LISTINGS'), ctrl.rejectProperty);
// 4.15 — ask for fixes without refusing the listing.
router.patch('/properties/:id/request-changes', requirePermission('LISTINGS'), ctrl.requestPropertyChanges);
router.patch('/properties/:id',         requirePermission('LISTINGS'), ctrl.editProperty);

// 4.10 / 4.11 — builder projects. Static segments stay above /projects/:id.
router.get('/projects', requirePermission('LISTINGS'), projectCtrl.listAdmin);
router.get('/projects/:id', requirePermission('LISTINGS'), projectCtrl.getAdmin);
router.patch('/projects/:id/approve',        requirePermission('LISTINGS'), projectCtrl.approve);
router.patch('/projects/:id/reject',         requirePermission('LISTINGS'), projectCtrl.reject);
router.patch('/projects/:id/request-changes', requirePermission('LISTINGS'), projectCtrl.requestChanges);
router.patch('/projects/:id/approvals/:item', requirePermission('LISTINGS'), projectCtrl.setApprovalItem);
// R28 — admin-only; a builder cannot set their own brokerage rate.
router.patch('/projects/:id/brokerage',       requirePermission('COMMISSION'), projectCtrl.setBrokerage);

// R28 — builder brokerage invoices. Static segments stay above
// /builder-invoices/:id for the same reason as /projects/:id above.
router.get('/builder-invoices', requirePermission(['FINANCE', 'FINANCE_VIEW']), builderInvoiceCtrl.listAdmin);
router.post('/builder-invoices',                requirePermission('FINANCE'), builderInvoiceCtrl.createInvoice);
router.post('/builder-invoices/:id/collect',    requirePermission('FINANCE'), builderInvoiceCtrl.collectInvoice);
router.post('/builder-invoices/:id/dispute',    requirePermission('FINANCE'), builderInvoiceCtrl.disputeInvoice);

// KYC
router.get('/kyc', requirePermission('KYC'), ctrl.getPendingKyc);
router.get('/kyc/:userId', requirePermission('KYC'), ctrl.getKycById);
// 16.x — one of a small, deliberately selective set of routes gated by the
// permission matrix in this pass (see the staff-directory routes above for
// why) — a SUPPORT staffRole can see KYC queues without also being able to
// verify one.
router.patch('/kyc/:userId/verify', requirePermission('KYC'), ctrl.verifyKyc);
// 5.x — re-run the automated PAN/GSTIN/RERA check on demand.
router.post('/kyc/:userId/auto-verify', requirePermission('KYC'), ctrl.autoVerifyKyc);
// R9 — ask for specific documents instead of a flat reject.
router.post('/kyc/:userId/request-documents', requirePermission('KYC'), ctrl.requestKycDocuments);

// Revenue
router.get('/revenue', requirePermission('FINANCE'), ctrl.getRevenue);

// Audit logs
router.get('/audit-logs', requirePermission('STAFF'), ctrl.getAuditLogs);

// Partner metrics + drill-down
router.get('/partners', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC', 'FINANCE_VIEW', 'COMMISSION']), ctrl.getPartnerMetrics);
router.get('/partners/:id', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC', 'FINANCE_VIEW', 'COMMISSION']), ctrl.getPartnerById);
// 3.5 — flag a payout account for clarification, or clear it once fixed.
// BE-14 — FINANCE-gated: this also approves bank-account change requests,
// which swaps the real payout destination (razorpayFundAccountId).
router.patch('/partners/:id/payout-account/status', requirePermission('FINANCE'), ctrl.setPayoutAccountStatus);
router.post('/partners/:id/payout-account/sync',    requirePermission('FINANCE'), validateObjectId('id'), ctrl.syncPayoutAccount);
// R14 — every partner's payout account in one list.
router.get('/payout-accounts', requirePermission('FINANCE'), ctrl.listPayoutAccounts);

// Escrow (admin actions) — release/refund move real money, gated by FINANCE.
router.patch('/escrow/:id/release', requirePermission('FINANCE'), escrowCtrl.releaseEscrow);
router.post('/escrow/:id/refund', requirePermission('FINANCE'), escrowCtrl.refundEscrow);
router.post('/escrow/:id/refund-partial', requirePermission('FINANCE'), escrowCtrl.refundPartialEscrow);
router.post('/escrow/:id/refund-manual', requirePermission('FINANCE'), escrowCtrl.refundManualEscrow);
// Money model phase 2 — pay a partner commission that release held back (needs an accepted tax invoice for a GST-registered partner).
router.post('/escrow/:id/partner-payout', requirePermission('FINANCE'), validateObjectId('id'), escrowCtrl.payPartnerCommission);
// A release whose payouts went out but whose books (seller payout line, commission, TDS) were not written: re-run them.
router.post('/escrow/:id/repair-bookkeeping', requirePermission('FINANCE'), validateObjectId('id'), escrowCtrl.repairBookkeeping);
// R10 — freeze / unfreeze for dispute. BE-4 — FINANCE-gated, same as
// release/refund: freezing/unfreezing changes what release()/refund() will
// accept, so it's a money-moving-adjacent action, not a plain status flag.
router.post('/escrow/:id/freeze',   requirePermission('FINANCE'), escrowCtrl.freezeEscrow);
router.post('/escrow/:id/unfreeze', requirePermission('FINANCE'), escrowCtrl.unfreezeEscrow);
router.get('/escrow', requirePermission(['FINANCE', 'FINANCE_VIEW']), escrowCtrl.getAllEscrow);
router.get('/escrow/stats', requirePermission(['FINANCE', 'FINANCE_VIEW']), escrowCtrl.getEscrowStats);
// backend-work-still-open.md #5 — owner success fees (R26) that are
// INVOICED but not yet COLLECTED. Lives in commission.service.js (the
// underlying state is Lead.commissionStatus), routed here per the spec.
router.get('/escrow/fees-due',            requirePermission('FINANCE'), commissionCtrl.listFeesDue);
router.post('/escrow/fees-due/:id/remind', requirePermission('FINANCE'), commissionCtrl.sendFeeReminder);
// 2.8/2.9 — split entitlements + release conditions, before releasing.
router.get('/escrow/:id/release-plan', requirePermission(['FINANCE', 'FINANCE_VIEW']), escrowCtrl.getReleasePlan);

// BE-2 — the way out of HELD_PAYOUT_FAILED (release()'s BE-1 fix can leave an
// escrow there when one payout leg fails after the other already succeeded).
// Same FINANCE gate as release/refund above — these move real money too.
router.get('/escrow/:id/payouts',                 requirePermission(['FINANCE', 'FINANCE_VIEW']), escrowCtrl.getPayouts); // audit F19: reading is allowed to the read-only role
router.post('/escrow/:id/payouts/retry',           requirePermission('FINANCE'), escrowCtrl.retryPayout);
router.post('/escrow/:id/payouts/resolve',         requirePermission('FINANCE'), escrowCtrl.resolvePayout);
router.post('/escrow/:id/payouts/refund-remaining', requirePermission('FINANCE'), escrowCtrl.refundRemaining);

// CMS
router.get('/content', requirePermission('CONTENT'), cmsCtrl.getAllForAdmin);
router.get('/content/:id', requirePermission('CONTENT'), cmsCtrl.getByIdForAdmin);
router.post('/content',       requirePermission('CONTENT'), auditAction('CMS_CONTENT_CREATED', 'Content'), cmsCtrl.create);
router.patch('/content/:id',  requirePermission('CONTENT'), auditAction('CMS_CONTENT_UPDATED', 'Content'), cmsCtrl.update);
router.delete('/content/:id', requirePermission('CONTENT'), auditAction('CMS_CONTENT_DELETED', 'Content'), cmsCtrl.remove);
// Not tied to a post id — works for an unsaved post; the editor PATCHes
// imageUrl onto the post separately once it has one.
router.post('/content/upload-image', requirePermission('CONTENT'), uploadContentImageMiddleware, cmsCtrl.uploadImage);

// Microsites — standalone public property pages (/m/<slug>). Writes are
// gated the same as properties (LISTINGS), since a microsite is an
// extension of a listing; reads use the router's own authenticate +
// requireAdmin only, same as the CMS /content routes above.
router.get('/microsites', requirePermission('LISTINGS'), micrositeCtrl.listForAdmin);
router.post('/microsites',         requirePermission('LISTINGS'), micrositeCtrl.create);
router.patch('/microsites/:id',    requirePermission('LISTINGS'), validateObjectId('id'), micrositeCtrl.update);
router.delete('/microsites/:id',   requirePermission('LISTINGS'), validateObjectId('id'), micrositeCtrl.remove);

// Notifications
router.post('/notifications/broadcast', requirePermission('CONTENT'), notifCtrl.broadcast);

// Ticket management
router.get('/tickets', requirePermission('TICKETS'), ctrl.getTickets);
router.get('/tickets/stats', requirePermission('TICKETS'), ctrl.getTicketStats);
router.get('/ratings/summary', requirePermission('TICKETS'), ctrl.getRatingsSummary);
router.get('/tickets/:id', requirePermission('TICKETS'), ctrl.getTicket);
router.patch('/tickets/:id',      requirePermission('TICKETS'), ctrl.updateTicket);
// 7.2 / 7.9 — real vendor dispatch; calling again with a different vendorId reassigns.
router.patch('/tickets/:id/dispatch',   requirePermission('TICKETS'), ctrl.dispatchTicket);
// 7.4 / 7.5 — resolve with charge breakdown + before/after evidence.
router.patch('/tickets/:id/resolve',    requirePermission('TICKETS'), ctrl.resolveTicket);
// 7.8
router.patch('/tickets/:id/link-deal',  requirePermission('TICKETS'), ctrl.linkTicketToDeal);
// backend-work-still-open.md #9 — same thread the user sees; admin can
// read/reply on any ticket, not scoped to one raised by them.
router.get('/tickets/:id/comments', requirePermission('TICKETS'), ctrl.getTicketComments);
router.post('/tickets/:id/comments',    requirePermission('TICKETS'), ctrl.addTicketComment);
// backend-work-still-open.md #7 — rule-driven dispatch, an alternative to
// manually naming a vendor via PATCH .../dispatch above.
router.post('/tickets/:id/auto-dispatch', requirePermission('TICKETS'), ctrl.dispatchTicketAutomatically);

// Loan management
router.get('/loan', requirePermission('FINANCE'), ctrl.getLoans);
router.get('/loan/bank-stats', requirePermission('FINANCE'), ctrl.getLoanBankStats);
router.get('/loan/:id', requirePermission('FINANCE'), ctrl.getLoanById);
router.patch('/loan/:id/status', requirePermission('FINANCE'), auditAction('LOAN_STATUS_UPDATED', 'LoanApplication'), ctrl.updateLoanStatus);

// User management & role assignment
router.get('/users', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC']), ctrl.getUsers);
router.get('/users/:id', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC']), ctrl.getUserById);
router.get('/users/:id/inquiries', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC']), validateObjectId('id'), ctrl.getUserInquiries);
router.get('/users/:id/subscriptions', requirePermission(['USERS', 'LEADS', 'TICKETS', 'KYC']), validateObjectId('id'), ctrl.getUserSubscriptions);
router.patch('/users/:id/role',        requirePermission('USERS'), ctrl.changeUserRole);
router.patch('/users/:id/suspend',     requirePermission('USERS'), ctrl.suspendUser);
// Backend gaps handoff, 2026-10-10 (#3) — a user's own privacy/consent
// audit trail. Gated by its own PRIVACY permission (see
// utils/adminPermissions.js), not bundled into the general requireAdmin
// check every other route here still uses.
router.get('/users/:id/privacy-events', requirePermission('PRIVACY'), ctrl.getUserPrivacyEvents);

// 16.x — staff directory / permission matrix. Gated by the STAFF permission
// itself: who can grant permissions is the single most sensitive surface
// this feature adds, so it's the one place requirePermission is applied in
// this pass rather than left on the blanket requireAdmin check every other
// admin route still uses.
router.get('/staff',               requirePermission('STAFF'), ctrl.listStaff);
router.post('/staff/:id',          requirePermission('STAFF'), ctrl.createStaffMember);
router.patch('/staff/:id',         requirePermission('STAFF'), ctrl.updateStaffPermissions);
router.delete('/staff/:id',        requirePermission('STAFF'), ctrl.removeStaffMember);

// Service catalog management
router.get('/services', requirePermission('CONTENT'), ctrl.listServices);
router.post('/services',        requirePermission('CONTENT'), auditAction('SERVICE_CREATED', 'Service', { idParam: 'id' }), ctrl.createService);
router.patch('/services/:id',   requirePermission('CONTENT'), auditAction('SERVICE_UPDATED', 'Service'), ctrl.updateService);
router.delete('/services/:id',  requirePermission('CONTENT'), auditAction('SERVICE_DELETED', 'Service'), ctrl.deleteService);

// User document vault review (Pattern 12)
router.get('/documents', requirePermission('KYC'), ctrl.listDocuments);
router.patch('/documents/:id/verify',  requirePermission('KYC'), auditAction('DOCUMENT_REVIEWED', 'UserDocument'), ctrl.verifyDocument);

// Contact inbox (docs 11.1-11.5)
router.get('/contact', requirePermission(['LEADS', 'TICKETS']), ctrl.listContactMessages);
// Templates before /contact/:id so "templates" isn't swallowed as an id.
router.get('/contact/templates', requirePermission(['LEADS', 'TICKETS']), contactCtrl.listTemplates);
router.post('/contact/templates', requirePermission(['LEADS', 'TICKETS']), contactCtrl.createTemplate);
router.patch('/contact/templates/:id', requirePermission(['LEADS', 'TICKETS']), contactCtrl.updateTemplate);
router.delete('/contact/templates/:id', requirePermission(['LEADS', 'TICKETS']), contactCtrl.deleteTemplate);
router.post('/contact/compose', requirePermission(['LEADS', 'TICKETS']), contactCtrl.compose);
router.get('/contact/:id', requirePermission(['LEADS', 'TICKETS']), contactCtrl.getThread);
router.patch('/contact/:id/read', requirePermission(['LEADS', 'TICKETS']), ctrl.markContactRead);
router.patch('/contact/:id/status', requirePermission(['LEADS', 'TICKETS']), contactCtrl.setStatus);
router.post('/contact/:id/reply', requirePermission(['LEADS', 'TICKETS']), contactCtrl.reply);

// Partner support tickets (Help & Support, partner side) — mirrors the
// contact inbox's list shape (pagination + statusCounts). Reads sit on the
// router's blanket authenticate+requireAdmin only, same as /contact above;
// the write (reply/status) is gated with TICKETS since it can email the
// partner and change a ticket's state.
router.get('/partner-support-tickets', requirePermission('TICKETS'), partnerTicketCtrl.listPartnerTickets);
router.get('/partner-support-tickets/:id', requirePermission('TICKETS'), validateObjectId('id'), partnerTicketCtrl.getPartnerTicketById);
router.patch('/partner-support-tickets/:id', requirePermission('TICKETS'), validateObjectId('id'), partnerTicketCtrl.updatePartnerTicket);

// NRI leads inbox
// Build-out (onboarding) forms: admin creates a private link for a builder / owner, sees what comes back, edits it after the
// discussion. Whole area needs LISTINGS, including reads (it holds the sender's documents).
router.get('/onboarding',                      requirePermission('LISTINGS'), onboardingCtrl.list);
router.post('/onboarding',                     requirePermission('LISTINGS'), onboardingCtrl.create);
router.get('/onboarding/:id',                  validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.get);
router.patch('/onboarding/:id',                validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.update);
router.post('/onboarding/:id/notes',           validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.addNote);
router.post('/onboarding/:id/reopen',          validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.reopen);
router.get('/onboarding/:id/listing-preview',  validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.listingPreview);
router.post('/onboarding/:id/convert',         validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.convert);
router.post('/onboarding/:id/revoke',          validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.revoke);
router.post('/onboarding/:id/documents/:docKey', validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.validateDocKey, onboardingDocUploader.single('file'), onboardingCtrl.adminUpload);
router.delete('/onboarding/:id/documents/:docId', validateObjectId('id'), requirePermission('LISTINGS'), onboardingCtrl.adminRemoveFile);

router.get('/nri-leads', requirePermission('LEADS'), ctrl.listNriLeads);
router.patch('/nri-leads/:id/read', requirePermission('LEADS'), auditAction('NRI_LEAD_MARKED_READ', 'NriLead'), ctrl.markNriLeadRead);

// Team roster
router.get('/team', requirePermission('CONTENT'), ctrl.listTeam);
router.post('/team',         requirePermission('CONTENT'), auditAction('TEAM_MEMBER_CREATED', 'TeamMember', { idParam: 'id' }), ctrl.createTeamMember);
router.patch('/team/:id',    requirePermission('CONTENT'), auditAction('TEAM_MEMBER_UPDATED', 'TeamMember'), ctrl.updateTeamMember);
router.delete('/team/:id',   requirePermission('CONTENT'), auditAction('TEAM_MEMBER_DELETED', 'TeamMember'), ctrl.deleteTeamMember);

// Video tour requests
router.get('/video-tours', requirePermission('LEADS'), ctrl.listVideoTours);
router.patch('/video-tours/:id', requirePermission('LEADS'), auditAction('VIDEO_TOUR_UPDATED', 'VideoTour'), ctrl.updateVideoTour);
router.post('/video-tours/:id/upload', requirePermission('LEADS'), videoTourUploader.single('video'), ctrl.uploadVideoTourFile);

// Vendor catalog
router.get('/vendors', requirePermission('TICKETS'), ctrl.listVendors);
router.post('/vendors',        requirePermission('TICKETS'), auditAction('VENDOR_CREATED', 'Vendor', { idParam: 'id' }), ctrl.createVendor);
router.get('/vendors/:id', requirePermission('TICKETS'), ctrl.getVendor);
router.patch('/vendors/:id',   requirePermission('TICKETS'), auditAction(vendorPatchAction, 'Vendor'), ctrl.updateVendor);
router.delete('/vendors/:id',  requirePermission('TICKETS'), auditAction('VENDOR_DEACTIVATED', 'Vendor'), ctrl.deleteVendor);
// 7.1 — recurring weekly availability.
router.get('/vendors/:id/availability', requirePermission('TICKETS'), ctrl.listVendorAvailability);
router.post('/vendors/:id/availability',            requirePermission('TICKETS'), ctrl.addVendorAvailability);
router.delete('/vendors/:id/availability/:slotId',  requirePermission('TICKETS'), ctrl.deleteVendorAvailability);

// Platform analytics (funnel + cohorts)
router.get('/analytics', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), ctrl.getAnalytics);
// 13.1-13.5 — period-filtered funnel, growth, NRI, revenue streams, float.
router.get('/analytics/overview', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), analyticsCtrl.overview);
router.get('/analytics/funnel', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), analyticsCtrl.funnel);
router.get('/analytics/users', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), analyticsCtrl.users);
router.get('/analytics/nri', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), analyticsCtrl.nri);
router.get('/analytics/revenue', requirePermission(['FINANCE', 'FINANCE_VIEW']), analyticsCtrl.revenue);
router.get('/analytics/escrow-float', requirePermission(['FINANCE', 'FINANCE_VIEW']), analyticsCtrl.escrowFloat);
router.get('/analytics/benchmarks', requirePermission(['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']), analyticsCtrl.benchmarks);

// Dispute management
router.get('/disputes', requirePermission(['TICKETS', 'FINANCE', 'FINANCE_VIEW']), ctrl.listDisputes);
// Audit Nov 2026 (F19): changing a dispute needs a write role; FINANCE_VIEW (read only) may look but not change it.
router.patch('/disputes/:id', requirePermission(['TICKETS', 'FINANCE']), ctrl.resolveDispute);

// Review moderation
router.get('/reviews', requirePermission('TICKETS'), ctrl.listReviews);
router.patch('/reviews/:id/moderate', requirePermission('TICKETS'), ctrl.moderateReview);

// WhatsApp (WATI) — templates, delivery log, spend (docs 12.1-12.6)
// 4 Nov 2026: templates are created, edited and submitted in the WATI dashboard, not here. The write routes stay closed unless
// WATI_TEMPLATE_EDITING=true is set, so nothing here can change what WATI sends.
const templatesManagedInWati = (req, res, next) => (process.env.WATI_TEMPLATE_EDITING === 'true' ? next() : next(new ApiError(403, 'Templates are managed in the WATI dashboard.')));
// WhatsApp chats: every message in and out as a thread per number, with full details of each message.
router.get('/whatsapp/conversations',              requirePermission('LEADS'), whatsappInboxCtrl.conversations);
router.get('/whatsapp/conversations/:phone',       requirePermission('LEADS'), whatsappInboxCtrl.thread);
router.post('/whatsapp/import',                    requirePermission('LEADS'), whatsappInboxCtrl.importFromWati);
router.post('/whatsapp/conversations/:phone/lead', requirePermission('LEADS'), whatsappInboxCtrl.makeLead);
router.get('/whatsapp/messages/:id',               validateObjectId('id'), requirePermission('LEADS'), whatsappInboxCtrl.message);
router.get('/wati/stats', requirePermission(['LEADS', 'CONTENT']), watiCtrl.getStats);
router.get('/wati/messages', requirePermission(['LEADS', 'CONTENT']), watiCtrl.listMessages);
router.get('/wati/messages/:id',           validateObjectId('id'), requirePermission(['LEADS', 'CONTENT']), whatsappInboxCtrl.logDetail);
router.get('/wati/templates', requirePermission(['LEADS', 'CONTENT']), watiCtrl.listTemplates);
router.post('/wati/templates',             templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.createTemplate);
router.get('/wati/templates/:id', requirePermission(['LEADS', 'CONTENT']), watiCtrl.getTemplate);
router.patch('/wati/templates/:id',        templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.updateTemplate);
router.delete('/wati/templates/:id',       templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.deleteTemplate);
router.post('/wati/templates/:id/submit',  templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.submitTemplate);
router.patch('/wati/templates/:id/status', templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.syncStatus);
router.post('/wati/templates/:id/test-send', templatesManagedInWati, requirePermission('CONTENT'), watiCtrl.testSend);

// B2B network oversight (B5.10) — admin watches these connections to catch
// offline bypass, so unlike the partner views this one does include contacts.
router.get('/b2b', requirePermission('USERS'), b2bCtrl.adminList);
router.patch('/b2b/:id', requirePermission('USERS'), b2bCtrl.adminUpdate);

// Commission rate cards, overrides and per-lead negotiated terms (3.12-3.17)
router.get('/rate-cards', requirePermission(['COMMISSION', 'FINANCE_VIEW']), commissionCtrl.listRateCards);
router.post('/rate-cards',           requirePermission('COMMISSION'), commissionCtrl.createRateCard);
router.patch('/rate-cards/:id',      requirePermission('COMMISSION'), commissionCtrl.updateRateCard);
router.delete('/rate-cards/:id',     requirePermission('COMMISSION'), commissionCtrl.deleteRateCard);
// Money model phase 2 — ledger, TDS ledger, tax invoices, exports.
router.use('/money', require('../money/money.routes'));

// Money model Rev 3 — negotiated partner rate per Project (T58). Changing a
// rate is a COMMISSION-gated action; it applies to leads assigned afterwards.
router.get('/project-rates', requirePermission(['COMMISSION', 'FINANCE_VIEW']), commissionCtrl.listProjectRates);
router.get('/projects/:id/commission-rate', requirePermission(['LISTINGS', 'COMMISSION']), commissionCtrl.getProjectRate);
router.put('/projects/:id/commission-rate',  requirePermission('COMMISSION'), commissionCtrl.setProjectRate);
router.delete('/projects/:id/commission-rate', requirePermission('COMMISSION'), commissionCtrl.clearProjectRate);
router.get('/commission-overrides', requirePermission(['COMMISSION', 'FINANCE_VIEW']), commissionCtrl.listOverrides);
router.post('/commission-overrides',       requirePermission('COMMISSION'), commissionCtrl.createOverride);
router.delete('/commission-overrides/:id', requirePermission('COMMISSION'), commissionCtrl.revokeOverride);
// A lead's own terms are the money record; the card only pre-fills them.
router.get('/leads/:id/commission', requirePermission(['LEADS', 'COMMISSION', 'FINANCE', 'FINANCE_VIEW']), commissionCtrl.getLeadTerms);
router.get('/leads/:id/commission/preview', requirePermission(['LEADS', 'COMMISSION', 'FINANCE', 'FINANCE_VIEW']), commissionCtrl.previewLeadTerms);
router.get('/leads/:id/commission/history', requirePermission(['LEADS', 'COMMISSION', 'FINANCE', 'FINANCE_VIEW']), commissionCtrl.leadTermsHistory);
router.post('/leads/:id/commission/prefill', requirePermission('COMMISSION'), commissionCtrl.prefillLeadTerms);
router.put('/leads/:id/commission',          requirePermission('COMMISSION'), commissionCtrl.setLeadTerms);
router.put('/leads/:id/commission/deal-rate', validateObjectId('id'), requirePermission('COMMISSION'), commissionCtrl.setDealRate);
// 16.x — locking/collecting commission is a FINANCE-gated action; setting
// terms (above, PUT) is left ungated on COMMISSION since negotiating terms
// and actually finalizing/collecting money are different levels of trust.
router.post('/leads/:id/commission/lock',    requirePermission('COMMISSION'), commissionCtrl.lockLeadTerms);
// R26 — owner success-fee payment record + receipt.
router.post('/leads/:id/commission/invoice', requirePermission('FINANCE'), commissionCtrl.invoiceLeadCommission);
router.post('/leads/:id/commission/collect', requirePermission('FINANCE'), commissionCtrl.collectLeadCommission);
router.post('/leads/:id/commission/dispute', requirePermission('FINANCE'), commissionCtrl.disputeLeadCommission);

// R29 — advisor referrals (oversight; creation is self-service, see
// POST /api/partner/referrals).
router.get('/advisor-referrals', requirePermission('USERS'), referralCtrl.listAdmin);
router.patch('/advisor-referrals/:id/revoke', requirePermission('USERS'), referralCtrl.revokeAdmin);

// Platform config
router.get('/config', requirePermission('FINANCE'), ctrl.listConfig);
router.put('/config/:key',    requirePermission('FINANCE'), auditAction('PLATFORM_CONFIG_SET', 'PlatformConfig', { idParam: 'key' }), ctrl.upsertConfig);
router.delete('/config/:key', requirePermission('FINANCE'), auditAction('PLATFORM_CONFIG_DELETED', 'PlatformConfig', { idParam: 'key' }), ctrl.deleteConfig);

module.exports = router;
