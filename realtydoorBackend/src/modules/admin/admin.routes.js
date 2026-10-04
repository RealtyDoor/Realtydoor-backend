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
const { authenticate } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireRole');
const { requirePermission } = require('../../middleware/requirePermission');
const { perUserLimiter } = require('../../middleware/rateLimiter');
const { videoTourUploader } = require('../../lib/fileUpload');

router.use(authenticate, requireAdmin, perUserLimiter);

// Lead management
router.get('/leads',        ctrl.getLeads);
router.post('/leads',       ctrl.createLead);          // 6.4a — admin logs an off-platform lead
// Auto-assign: static path, registered above /leads/:id so it is never
// swallowed as a lead id.
router.post('/leads/auto-assign', ctrl.autoAssignUnassignedLeads);
router.get('/leads/:id',    ctrl.getLeadById);
router.patch('/leads/:id/assign',        ctrl.assignLead);
router.post('/leads/:id/auto-assign',    ctrl.autoAssignLead);
// 6.3 — vet a partner-added (AWAITING_ADMIN) lead. Confirm optionally assigns
// in one step; passing a different partnerId is the reassign case.
router.patch('/leads/:id/confirm',       ctrl.confirmLead);
router.patch('/leads/:id/reject',        ctrl.rejectLead);
// 6.6 — clear a locked site-visit OTP and issue a fresh code to the buyer.
router.patch('/leads/:id/otp-override',  ctrl.overrideLeadOtp);
router.patch('/leads/:id/approve-drop',  leadsCtrl.approveDrop);
router.patch('/leads/:id/reject-drop',   leadsCtrl.rejectDrop);

// Property approval + admin edit
router.get('/properties',              ctrl.getPendingProperties);
// 4.8 / 4.9 / 4.12 / 4.13 — these sit ABOVE /properties/:id deliberately.
// Express matches in order, so registering them after the param route would
// make :id swallow "change-requests" and "edit-logs" as property ids.
router.get('/properties/change-requests',            listingCtrl.listChangeRequests);
router.get('/properties/change-requests/:id',        listingCtrl.getChangeRequest);
router.patch('/properties/change-requests/:id/approve', listingCtrl.approveChangeRequest);
router.patch('/properties/change-requests/:id/reject',  listingCtrl.rejectChangeRequest);
router.get('/properties/edit-logs',                  listingCtrl.listEditLogs);
// 4.3 / 4.4 — mandates and conflict detection. Static segments stay above the
// /properties/:id param route for the same reason as the change-request ones.
router.get('/properties/mandates',                   integrityCtrl.listMandates);
router.get('/properties/mandates/:id',               integrityCtrl.getMandate);
router.patch('/properties/mandates/:id/revoke',      integrityCtrl.revokeMandate);
router.get('/properties/conflicts',                  integrityCtrl.listConflicts);
router.patch('/properties/conflicts/:id/resolve',    integrityCtrl.resolveConflict);
router.post('/properties/:id/mandates',              integrityCtrl.createMandate);
router.post('/properties/:id/detect-conflicts',      integrityCtrl.detectConflicts);
// 4.6 / 4.7 — location check and admin location edit.
router.get('/properties/:id/location-check',          locationCtrl.locationCheck);
router.patch('/properties/:id/location',              locationCtrl.updateLocation);
// 4.1 / 4.2 — persona document checklist and owner-confirmation review.
router.get('/properties/:id/checklist',                checklistCtrl.getChecklist);
router.patch('/properties/checklist-documents/:docId/verify', checklistCtrl.verifyChecklistDocument);
router.patch('/properties/checklist-documents/:docId/reject', checklistCtrl.rejectChecklistDocument);
router.post('/properties/:id/mandates/:mandateId/owner-confirmation/request', checklistCtrl.requestOwnerConfirmation);
router.patch('/properties/owner-confirmation/:confirmationId', checklistCtrl.recordOwnerConfirmation);
router.get('/properties/:id',          ctrl.getPropertyById);
router.patch('/properties/:id/approve', ctrl.approveProperty);
router.patch('/properties/:id/reject',  ctrl.rejectProperty);
// 4.15 — ask for fixes without refusing the listing.
router.patch('/properties/:id/request-changes', ctrl.requestPropertyChanges);
router.patch('/properties/:id',         ctrl.editProperty);

// 4.10 / 4.11 — builder projects. Static segments stay above /projects/:id.
router.get('/projects',                      projectCtrl.listAdmin);
router.get('/projects/:id',                  projectCtrl.getAdmin);
router.patch('/projects/:id/approve',        projectCtrl.approve);
router.patch('/projects/:id/reject',         projectCtrl.reject);
router.patch('/projects/:id/request-changes', projectCtrl.requestChanges);
router.patch('/projects/:id/approvals/:item', projectCtrl.setApprovalItem);
// R28 — admin-only; a builder cannot set their own brokerage rate.
router.patch('/projects/:id/brokerage',       projectCtrl.setBrokerage);

// R28 — builder brokerage invoices. Static segments stay above
// /builder-invoices/:id for the same reason as /projects/:id above.
router.get('/builder-invoices',                builderInvoiceCtrl.listAdmin);
router.post('/builder-invoices',                builderInvoiceCtrl.createInvoice);
router.post('/builder-invoices/:id/collect',    builderInvoiceCtrl.collectInvoice);
router.post('/builder-invoices/:id/dispute',    builderInvoiceCtrl.disputeInvoice);

// KYC
router.get('/kyc',                ctrl.getPendingKyc);
router.get('/kyc/:userId',        ctrl.getKycById);
// 16.x — one of a small, deliberately selective set of routes gated by the
// permission matrix in this pass (see the staff-directory routes above for
// why) — a SUPPORT staffRole can see KYC queues without also being able to
// verify one.
router.patch('/kyc/:userId/verify', requirePermission('KYC'), ctrl.verifyKyc);
// R9 — ask for specific documents instead of a flat reject.
router.post('/kyc/:userId/request-documents', ctrl.requestKycDocuments);

// Revenue
router.get('/revenue', ctrl.getRevenue);

// Audit logs
router.get('/audit-logs', ctrl.getAuditLogs);

// Partner metrics + drill-down
router.get('/partners',     ctrl.getPartnerMetrics);
router.get('/partners/:id', ctrl.getPartnerById);
// 3.5 — flag a payout account for clarification, or clear it once fixed.
router.patch('/partners/:id/payout-account/status', ctrl.setPayoutAccountStatus);
// R14 — every partner's payout account in one list.
router.get('/payout-accounts', ctrl.listPayoutAccounts);

// Escrow (admin actions) — release/refund move real money, gated by FINANCE.
router.patch('/escrow/:id/release', requirePermission('FINANCE'), escrowCtrl.releaseEscrow);
router.post('/escrow/:id/refund', requirePermission('FINANCE'), escrowCtrl.refundEscrow);
// R10 — freeze / unfreeze for dispute.
router.post('/escrow/:id/freeze',   escrowCtrl.freezeEscrow);
router.post('/escrow/:id/unfreeze', escrowCtrl.unfreezeEscrow);
router.get('/escrow', escrowCtrl.getAllEscrow);
router.get('/escrow/stats', escrowCtrl.getEscrowStats);
// 2.8/2.9 — split entitlements + release conditions, before releasing.
router.get('/escrow/:id/release-plan', escrowCtrl.getReleasePlan);

// CMS
router.get('/content',        cmsCtrl.getAllForAdmin);
router.get('/content/:id',    cmsCtrl.getByIdForAdmin);
router.post('/content',       cmsCtrl.create);
router.patch('/content/:id',  cmsCtrl.update);
router.delete('/content/:id', cmsCtrl.remove);

// Notifications
router.post('/notifications/broadcast', notifCtrl.broadcast);

// Ticket management
router.get('/tickets',            ctrl.getTickets);
router.get('/tickets/stats',      ctrl.getTicketStats);
router.get('/tickets/:id',        ctrl.getTicket);
router.patch('/tickets/:id',      ctrl.updateTicket);
// 7.2 / 7.9 — real vendor dispatch; calling again with a different vendorId reassigns.
router.patch('/tickets/:id/dispatch',   ctrl.dispatchTicket);
// 7.4 / 7.5 — resolve with charge breakdown + before/after evidence.
router.patch('/tickets/:id/resolve',    ctrl.resolveTicket);
// 7.8
router.patch('/tickets/:id/link-deal',  ctrl.linkTicketToDeal);

// Loan management
router.get('/loan',               ctrl.getLoans);
router.get('/loan/bank-stats',    ctrl.getLoanBankStats);
router.patch('/loan/:id/status',  ctrl.updateLoanStatus);

// User management & role assignment
router.get('/users',                   ctrl.getUsers);
router.get('/users/:id',               ctrl.getUserById);
router.patch('/users/:id/role',        ctrl.changeUserRole);
router.patch('/users/:id/suspend',     ctrl.suspendUser);

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
router.get('/services',         ctrl.listServices);
router.post('/services',        ctrl.createService);
router.patch('/services/:id',   ctrl.updateService);
router.delete('/services/:id',  ctrl.deleteService);

// User document vault review (Pattern 12)
router.get('/documents',               ctrl.listDocuments);
router.patch('/documents/:id/verify',  ctrl.verifyDocument);

// Contact inbox (docs 11.1-11.5)
router.get('/contact',                  ctrl.listContactMessages);
// Templates before /contact/:id so "templates" isn't swallowed as an id.
router.get('/contact/templates',        contactCtrl.listTemplates);
router.post('/contact/templates',       contactCtrl.createTemplate);
router.patch('/contact/templates/:id',  contactCtrl.updateTemplate);
router.delete('/contact/templates/:id', contactCtrl.deleteTemplate);
router.post('/contact/compose',         contactCtrl.compose);
router.get('/contact/:id',              contactCtrl.getThread);
router.patch('/contact/:id/read',       ctrl.markContactRead);
router.patch('/contact/:id/status',     contactCtrl.setStatus);
router.post('/contact/:id/reply',       contactCtrl.reply);

// NRI leads inbox
router.get('/nri-leads',             ctrl.listNriLeads);
router.patch('/nri-leads/:id/read',  ctrl.markNriLeadRead);

// Team roster
router.get('/team',          ctrl.listTeam);
router.post('/team',         ctrl.createTeamMember);
router.patch('/team/:id',    ctrl.updateTeamMember);
router.delete('/team/:id',   ctrl.deleteTeamMember);

// Video tour requests
router.get('/video-tours',                                                   ctrl.listVideoTours);
router.patch('/video-tours/:id',                                             ctrl.updateVideoTour);
router.post('/video-tours/:id/upload', videoTourUploader.single('video'),   ctrl.uploadVideoTourFile);

// Vendor catalog
router.get('/vendors',         ctrl.listVendors);
router.post('/vendors',        ctrl.createVendor);
router.get('/vendors/:id',     ctrl.getVendor);
router.patch('/vendors/:id',   ctrl.updateVendor);
router.delete('/vendors/:id',  ctrl.deleteVendor);
// 7.1 — recurring weekly availability.
router.get('/vendors/:id/availability',             ctrl.listVendorAvailability);
router.post('/vendors/:id/availability',            ctrl.addVendorAvailability);
router.delete('/vendors/:id/availability/:slotId',  ctrl.deleteVendorAvailability);

// Platform analytics (funnel + cohorts)
router.get('/analytics', ctrl.getAnalytics);
// 13.1-13.5 — period-filtered funnel, growth, NRI, revenue streams, float.
router.get('/analytics/overview',      analyticsCtrl.overview);
router.get('/analytics/funnel',        analyticsCtrl.funnel);
router.get('/analytics/users',         analyticsCtrl.users);
router.get('/analytics/nri',           analyticsCtrl.nri);
router.get('/analytics/revenue',       analyticsCtrl.revenue);
router.get('/analytics/escrow-float',  analyticsCtrl.escrowFloat);
router.get('/analytics/benchmarks',    analyticsCtrl.benchmarks);

// Dispute management
router.get('/disputes',       ctrl.listDisputes);
router.patch('/disputes/:id', ctrl.resolveDispute);

// Review moderation
router.get('/reviews',                ctrl.listReviews);
router.patch('/reviews/:id/moderate', ctrl.moderateReview);

// WhatsApp (WATI) — templates, delivery log, spend (docs 12.1-12.6)
router.get('/wati/stats',                  watiCtrl.getStats);
router.get('/wati/messages',               watiCtrl.listMessages);
router.get('/wati/templates',              watiCtrl.listTemplates);
router.post('/wati/templates',             watiCtrl.createTemplate);
router.get('/wati/templates/:id',          watiCtrl.getTemplate);
router.patch('/wati/templates/:id',        watiCtrl.updateTemplate);
router.delete('/wati/templates/:id',       watiCtrl.deleteTemplate);
router.post('/wati/templates/:id/submit',  watiCtrl.submitTemplate);
router.patch('/wati/templates/:id/status', watiCtrl.syncStatus);
router.post('/wati/templates/:id/test-send', watiCtrl.testSend);

// B2B network oversight (B5.10) — admin watches these connections to catch
// offline bypass, so unlike the partner views this one does include contacts.
router.get('/b2b',         b2bCtrl.adminList);
router.patch('/b2b/:id',   b2bCtrl.adminUpdate);

// Commission rate cards, overrides and per-lead negotiated terms (3.12-3.17)
router.get('/rate-cards',            commissionCtrl.listRateCards);
router.post('/rate-cards',           commissionCtrl.createRateCard);
router.patch('/rate-cards/:id',      commissionCtrl.updateRateCard);
router.delete('/rate-cards/:id',     commissionCtrl.deleteRateCard);
router.get('/commission-overrides',        commissionCtrl.listOverrides);
router.post('/commission-overrides',       commissionCtrl.createOverride);
router.delete('/commission-overrides/:id', commissionCtrl.revokeOverride);
// A lead's own terms are the money record; the card only pre-fills them.
router.get('/leads/:id/commission',          commissionCtrl.getLeadTerms);
router.get('/leads/:id/commission/preview',  commissionCtrl.previewLeadTerms);
router.get('/leads/:id/commission/history',  commissionCtrl.leadTermsHistory);
router.post('/leads/:id/commission/prefill', commissionCtrl.prefillLeadTerms);
router.put('/leads/:id/commission',          commissionCtrl.setLeadTerms);
// 16.x — locking/collecting commission is a FINANCE-gated action; setting
// terms (above, PUT) is left ungated on COMMISSION since negotiating terms
// and actually finalizing/collecting money are different levels of trust.
router.post('/leads/:id/commission/lock',    requirePermission('COMMISSION'), commissionCtrl.lockLeadTerms);
// R26 — owner success-fee payment record + receipt.
router.post('/leads/:id/commission/invoice', requirePermission('FINANCE'), commissionCtrl.invoiceLeadCommission);
router.post('/leads/:id/commission/collect', requirePermission('FINANCE'), commissionCtrl.collectLeadCommission);
router.post('/leads/:id/commission/dispute', commissionCtrl.disputeLeadCommission);

// R29 — advisor referrals (oversight; creation is self-service, see
// POST /api/partner/referrals).
router.get('/advisor-referrals',             referralCtrl.listAdmin);
router.patch('/advisor-referrals/:id/revoke', referralCtrl.revokeAdmin);

// Platform config
router.get('/config',         ctrl.listConfig);
router.put('/config/:key',    ctrl.upsertConfig);
router.delete('/config/:key', ctrl.deleteConfig);

module.exports = router;
