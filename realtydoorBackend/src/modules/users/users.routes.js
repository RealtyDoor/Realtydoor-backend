const router = require('express').Router();
const ctrl = require('./users.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');
const { userDocUploader } = require('../../lib/fileUpload');
const { otpLimiter } = require('../../middleware/rateLimiter');

router.use(authenticate, requireUser);

// Profile
router.patch('/profile', ctrl.updateProfile);

// Onboarding consent
router.patch('/consent', ctrl.updateConsent);

// Phone verification (lazy — only called when needed)
router.post('/verify-phone',     otpLimiter, ctrl.requestPhoneOtp);
router.post('/verify-phone/otp', otpLimiter, ctrl.verifyPhoneOtp);

// Inquiries tracker
router.get('/leads', ctrl.getMyLeads);
router.post('/leads/:leadId/rating', ctrl.rateLead);

// Favorites (phone required — PRD §2.5)
router.get('/favorites',  ctrl.getFavorites);
router.post('/favorites', requirePhone, ctrl.toggleFavorite);

// Document vault
router.get('/documents', ctrl.getDocuments);
router.post('/documents', requirePhone, userDocUploader.single('file'), ctrl.uploadDocument);

// Service subscriptions
router.get('/subscriptions', ctrl.getSubscriptions);

// Tickets
router.get('/tickets',              ctrl.getMyTickets);
router.get('/tickets/:id',          ctrl.getMyTicketById);
router.post('/tickets',             requirePhone, ctrl.raiseTicket);
router.patch('/tickets/:id/verify', ctrl.verifyTicket);

// Loan applications
router.post('/loan',     requirePhone, ctrl.createLoanApplication);
router.get('/loan',                   ctrl.getMyLoanApplications);
router.get('/loan/:id',               ctrl.getLoanApplicationById);

// Video tour requests (NRI feature — Phase 2)
router.post('/video-tour',  requirePhone, ctrl.requestVideoTour);
router.get('/video-tours',               ctrl.getMyVideoTours);

// Disputes
router.post('/disputes', ctrl.raiseDispute);
router.get('/disputes',  ctrl.getMyDisputes);

module.exports = router;
