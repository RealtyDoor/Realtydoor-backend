const router = require('express').Router();
const ctrl = require('./leads.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser, requirePartner } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');
const { requireKyc } = require('../../middleware/requireKyc');
const { visitPhotoUploader } = require('../../lib/fileUpload');
const { otpLimiter } = require('../../middleware/rateLimiter');

// User submits inquiry (phone required — anti-leakage)
router.post('/', authenticate, requireUser, requirePhone, ctrl.submit);

// Partner routes
router.get('/partner', authenticate, requirePartner, requireKyc, ctrl.getMyLeads);
router.get('/partner/:id', authenticate, requirePartner, requireKyc, ctrl.getLeadById);
router.post('/partner/:id/schedule-visit', authenticate, requirePartner, requireKyc, ctrl.scheduleVisit);
router.post('/partner/:id/resend-otp', authenticate, requirePartner, requireKyc, otpLimiter, ctrl.resendOtp);
router.post('/partner/:id/request-otp-override', authenticate, requirePartner, requireKyc, ctrl.requestOtpOverride);
router.post('/partner/:id/verify-otp', authenticate, requirePartner, requireKyc, otpLimiter, ctrl.verifyOtp);
router.patch('/partner/:id/document', authenticate, requirePartner, requireKyc,
  visitPhotoUploader.fields([{ name: 'visitPhotos', maxCount: 10 }, { name: 'closureDocs', maxCount: 5 }]),
  ctrl.uploadDocs
);
router.patch('/partner/:id/close',        authenticate, requirePartner, requireKyc, ctrl.closeLead);
router.patch('/partner/:id/request-drop', authenticate, requirePartner, requireKyc, ctrl.requestDrop);

module.exports = router;
