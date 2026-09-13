const router = require('express').Router();
const ctrl = require('./admin.controller');
const escrowCtrl = require('../escrow/escrow.controller');
const cmsCtrl = require('../cms/cms.controller');
const notifCtrl = require('../notifications/notifications.controller');
const leadsCtrl = require('../leads/leads.controller');
const { authenticate } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireRole');
const { videoTourUploader } = require('../../lib/fileUpload');

router.use(authenticate, requireAdmin);

// Lead management
router.get('/leads',        ctrl.getLeads);
router.get('/leads/:id',    ctrl.getLeadById);
router.patch('/leads/:id/assign',        ctrl.assignLead);
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

// Escrow (admin actions)
router.patch('/escrow/:id/release', escrowCtrl.releaseEscrow);
router.post('/escrow/:id/refund', escrowCtrl.refundEscrow);
router.get('/escrow', escrowCtrl.getAllEscrow);

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
router.get('/tickets/:id',        ctrl.getTicket);
router.patch('/tickets/:id',      ctrl.updateTicket);

// Loan management
router.get('/loan',               ctrl.getLoans);
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

// Platform config
router.get('/config',         ctrl.listConfig);
router.put('/config/:key',    ctrl.upsertConfig);
router.delete('/config/:key', ctrl.deleteConfig);

module.exports = router;
