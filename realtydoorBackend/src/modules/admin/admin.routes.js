const router = require('express').Router();
const ctrl = require('./admin.controller');
const escrowCtrl = require('../escrow/escrow.controller');
const cmsCtrl = require('../cms/cms.controller');
const notifCtrl = require('../notifications/notifications.controller');
const leadsCtrl = require('../leads/leads.controller');
const watiCtrl = require('../wati/wati.controller');
const b2bCtrl = require('../b2b/b2b.controller');
const { authenticate } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireRole');
const { perUserLimiter } = require('../../middleware/rateLimiter');
const { videoTourUploader } = require('../../lib/fileUpload');

router.use(authenticate, requireAdmin, perUserLimiter);

// Lead management
router.get('/leads',        ctrl.getLeads);
router.post('/leads',       ctrl.createLead);          // 6.4a — admin logs an off-platform lead
router.get('/leads/:id',    ctrl.getLeadById);
router.patch('/leads/:id/assign',        ctrl.assignLead);
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
router.get('/properties/:id',          ctrl.getPropertyById);
router.patch('/properties/:id/approve', ctrl.approveProperty);
router.patch('/properties/:id/reject',  ctrl.rejectProperty);
router.patch('/properties/:id',         ctrl.editProperty);

// KYC
router.get('/kyc',                ctrl.getPendingKyc);
router.get('/kyc/:userId',        ctrl.getKycById);
router.patch('/kyc/:userId/verify', ctrl.verifyKyc);

// Revenue
router.get('/revenue', ctrl.getRevenue);

// Audit logs
router.get('/audit-logs', ctrl.getAuditLogs);

// Partner metrics + drill-down
router.get('/partners',     ctrl.getPartnerMetrics);
router.get('/partners/:id', ctrl.getPartnerById);
// 3.5 — flag a payout account for clarification, or clear it once fixed.
router.patch('/partners/:id/payout-account/status', ctrl.setPayoutAccountStatus);

// Escrow (admin actions)
router.patch('/escrow/:id/release', escrowCtrl.releaseEscrow);
router.post('/escrow/:id/refund', escrowCtrl.refundEscrow);
router.get('/escrow', escrowCtrl.getAllEscrow);
router.get('/escrow/stats', escrowCtrl.getEscrowStats);

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

// Loan management
router.get('/loan',               ctrl.getLoans);
router.get('/loan/bank-stats',    ctrl.getLoanBankStats);
router.patch('/loan/:id/status',  ctrl.updateLoanStatus);

// User management & role assignment
router.get('/users',                   ctrl.getUsers);
router.get('/users/:id',               ctrl.getUserById);
router.patch('/users/:id/role',        ctrl.changeUserRole);
router.patch('/users/:id/suspend',     ctrl.suspendUser);

// Service catalog management
router.get('/services',         ctrl.listServices);
router.post('/services',        ctrl.createService);
router.patch('/services/:id',   ctrl.updateService);
router.delete('/services/:id',  ctrl.deleteService);

// User document vault review (Pattern 12)
router.get('/documents',               ctrl.listDocuments);
router.patch('/documents/:id/verify',  ctrl.verifyDocument);

// Contact inbox
router.get('/contact',             ctrl.listContactMessages);
router.patch('/contact/:id/read',  ctrl.markContactRead);

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
router.patch('/vendors/:id',   ctrl.updateVendor);
router.delete('/vendors/:id',  ctrl.deleteVendor);

// Platform analytics (funnel + cohorts)
router.get('/analytics', ctrl.getAnalytics);

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

// Platform config
router.get('/config',         ctrl.listConfig);
router.put('/config/:key',    ctrl.upsertConfig);
router.delete('/config/:key', ctrl.deleteConfig);

module.exports = router;
