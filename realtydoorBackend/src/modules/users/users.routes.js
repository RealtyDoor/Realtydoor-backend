const router = require('express').Router();
const ctrl = require('./users.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requireOnboarded } = require('../../middleware/requireOnboarded');
const { requirePhone } = require('../../middleware/requirePhone');
const { userDocUploader } = require('../../lib/fileUpload');
const { otpLimiter, perUserLimiter, perUserPhoneOtpLimiter, privacyActionLimiter } = require('../../middleware/rateLimiter');
const { validateObjectId } = require('../../middleware/validateObjectId');

router.use(authenticate, requireUser, perUserLimiter);

// requireOnboarded (B6) gates everything below except profile edits, the
// phone-verification endpoints, and every privacy path (both the canonical
// paths and their legacy aliases) — a user must always be able to see and
// withdraw consent / cancel a pending deletion, onboarded or not (backend
// gaps handoff #1/#2).
const ONBOARDING_EXEMPT_PATHS = [
  '/profile', '/verify-phone', '/verify-phone/otp',
  '/privacy', '/consent/withdraw', '/account/deletion-request',
  '/privacy/withdraw-consent', '/privacy/delete-account', '/privacy/delete-account/cancel',
];
router.use((req, res, next) => (
  ONBOARDING_EXEMPT_PATHS.includes(req.path) ? next() : requireOnboarded(req, res, next)
));

// Profile
router.patch('/profile', ctrl.updateProfile);

// Onboarding consent
router.patch('/consent', ctrl.updateConsent);
router.get('/consent', ctrl.getConsentState);

// Backend gaps handoff, 2026-10-10 (#1) — canonical privacy routes. The
// frontend (src/lib/privacy.ts) was built against these paths; the
// /privacy/* paths below are kept as aliases to the same handlers so an
// older build in the wild keeps working unchanged.
router.get('/privacy', ctrl.getPrivacyState);
router.post('/consent/withdraw',          privacyActionLimiter, ctrl.withdrawConsent);
router.post('/account/deletion-request',  privacyActionLimiter, ctrl.requestAccountDeletion);
router.delete('/account/deletion-request',                      ctrl.cancelAccountDeletion);

// Legacy aliases — same handlers, old no-body contracts.
router.post('/privacy/withdraw-consent',        privacyActionLimiter, ctrl.withdrawConsentLegacy);
router.post('/privacy/delete-account',          privacyActionLimiter, ctrl.requestAccountDeletionLegacy);
router.post('/privacy/delete-account/cancel',                         ctrl.cancelAccountDeletion);

// Phone verification (lazy — only called when needed). Backend gaps
// handoff, 2026-10-10 (follow-up) — otpLimiter alone is IP-keyed, which
// the frontend confirmed the backend previously saw as one shared IP for
// every user behind its proxy (no X-Forwarded-For forwarded). Now fixed
// upstream, but a shared network (office Wi-Fi, a mobile carrier's NAT)
// still genuinely shares one IP — perUserPhoneOtpLimiter stacks a
// per-user budget on top so those users don't exhaust each other's quota,
// while otpLimiter remains as the IP-keyed backstop.
router.post('/verify-phone',     otpLimiter, perUserPhoneOtpLimiter, ctrl.requestPhoneOtp);
router.post('/verify-phone/otp', otpLimiter, perUserPhoneOtpLimiter, ctrl.verifyPhoneOtp);

// Inquiries tracker
router.get('/leads', ctrl.getMyLeads);
router.get('/leads/:id', validateObjectId('id'), ctrl.getMyLead);
router.post('/leads/:leadId/rating', ctrl.rateLead);
router.post('/leads/:id/cancel', ctrl.cancelLead);

// Favorites (phone required — PRD §2.5)
router.get('/favorites',  ctrl.getFavorites);
router.post('/favorites', requirePhone, ctrl.toggleFavorite);

// Document vault
router.get('/documents', ctrl.getDocuments);
router.post('/documents', requirePhone, userDocUploader.single('file'), ctrl.uploadDocument);
router.delete('/documents/:id', validateObjectId('id'), ctrl.deleteDocument);

// Service subscriptions
router.get('/subscriptions', ctrl.getSubscriptions);

// Tickets
router.get('/tickets',              ctrl.getMyTickets);
router.get('/tickets/:id',          ctrl.getMyTicketById);
router.post('/tickets',             requirePhone, ctrl.raiseTicket);
router.patch('/tickets/:id/verify', ctrl.verifyTicket);
router.patch('/tickets/:id/reopen', ctrl.reopenTicket);
router.delete('/tickets/:id',       ctrl.withdrawTicket);
router.get('/tickets/:id/comments',  ctrl.getTicketComments);
router.post('/tickets/:id/comments', ctrl.addTicketComment);

// Loan applications
router.get('/loan/eligibility',       ctrl.getLoanEligibility);
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
