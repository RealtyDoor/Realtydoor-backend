const router = require('express').Router();
const ctrl = require('./partners.controller');
const leadsCtrl = require('../leads/leads.controller');
const commissionCtrl = require('../commission/commission.controller');
const { authenticate } = require('../../middleware/auth');
const { requirePartner } = require('../../middleware/requireRole');
const { requireKyc } = require('../../middleware/requireKyc');
const { kycDocUploader, visitPhotoUploader, partnerProfilePhotoUploader } = require('../../lib/fileUpload');
const { uploadLimiter, otpLimiter, perUserLimiter } = require('../../middleware/rateLimiter');

router.use(authenticate, requirePartner, perUserLimiter);

// KYC submission (no KYC required to submit it)
router.post('/kyc/consent', ctrl.recordKycConsent);
// B12.3 — accept a versioned commission/terms agreement.
router.post('/terms/accept', ctrl.acceptTerms);
// B12.2 — the partner's effective default plus their agreed per-lead terms.
router.get('/rate-cards', commissionCtrl.myRateCards);
router.post('/kyc', uploadLimiter, kycDocUploader.array('documents', 5), ctrl.submitKyc);

// Leads (KYC required)
router.post('/leads',                       requireKyc, leadsCtrl.partnerAddLead);
router.get('/leads',                        requireKyc, leadsCtrl.getMyLeads);
router.get('/leads/:id',                    requireKyc, leadsCtrl.getLeadById);
router.post('/leads/:id/schedule-visit',    requireKyc, leadsCtrl.scheduleVisit);
router.post('/leads/:id/resend-otp',        requireKyc, otpLimiter, leadsCtrl.resendOtp);
router.post('/leads/:id/request-otp-override', requireKyc, leadsCtrl.requestOtpOverride);
router.post('/leads/:id/verify-otp',        requireKyc, otpLimiter, leadsCtrl.verifyOtp);
router.patch('/leads/:id/document',         requireKyc,
  visitPhotoUploader.fields([
    { name: 'visitPhotos', maxCount: 10 }, { name: 'closureDocs', maxCount: 5 },
    // B5.3/B5.4 — one each per deal; closeLead gates on allocationLetter.
    { name: 'allocationLetter', maxCount: 1 }, { name: 'tokenReceipt', maxCount: 1 },
  ]),
  leadsCtrl.uploadDocs
);
router.patch('/leads/:id/status',           requireKyc, leadsCtrl.updateVisitOutcome);
router.patch('/leads/:id/close',            requireKyc, leadsCtrl.closeLead);
router.patch('/leads/:id/request-drop',     requireKyc, leadsCtrl.requestDrop);

// Profile
router.get('/profile', ctrl.getProfile);
router.patch('/profile', ctrl.updateProfile);
router.post('/profile/photo', partnerProfilePhotoUploader.single('photo'), ctrl.uploadProfilePhoto);

// Listings (KYC required)
router.get('/listings',    requireKyc, ctrl.getMyListings);
router.get('/listings/:id', requireKyc, ctrl.getListing);

// Finance/escrow summary (KYC required)
router.get('/finance',    requireKyc, ctrl.getFinanceSummary);
// Ratings from buyers, aggregated from Lead.buyerRating (KYC required)
router.get('/ratings',    requireKyc, ctrl.getRatings);
// Analytics dashboard (KYC required)
router.get('/analytics',  requireKyc, ctrl.getAnalytics);

// Settings (visit availability, notifications, lead preferences)
router.get('/settings',   ctrl.getSettings);
router.patch('/settings', ctrl.updateSettings);

// Bank account
router.get('/bank-account',   requireKyc, ctrl.getBankAccount);
// B12.1/B12.4 — RazorpayX payout account (no Route onboarding).
router.get('/payout-account',  ctrl.getPayoutAccount);
router.post('/payout-account', ctrl.createPayoutAccount);
router.patch('/bank-account', requireKyc, ctrl.updateBankAccount);

// Support tickets (Help & Support page)
router.get('/support-tickets',      ctrl.getSupportTickets);
router.post('/support-tickets',     ctrl.createSupportTicket);
router.get('/support-tickets/:id',  ctrl.getSupportTicketById);

module.exports = router;
