const router = require('express').Router();
const ctrl = require('./onboarding.controller');
const { defaultLimiter, publicFormLimiter, uploadLimiter } = require('../../middleware/rateLimiter');
const honeypot = require('../../middleware/honeypot');
const { onboardingDocUploader } = require('../../lib/fileUpload');

// Public, reached with the private link's secret in the path. Every answer is "private, no-store".
router.get('/:token', defaultLimiter, ctrl.senderGet);
router.put('/:token', defaultLimiter, ctrl.senderSave);
router.post('/:token/submit', defaultLimiter, publicFormLimiter, honeypot, ctrl.senderSubmit);
// The link is checked BEFORE the file is read, so a bad link cannot put anything in the bucket.
router.post('/:token/documents/:docKey', defaultLimiter, uploadLimiter, ctrl.requireLink, onboardingDocUploader.single('file'), ctrl.senderUpload);
router.delete('/:token/documents/:docId', defaultLimiter, ctrl.requireLink, ctrl.senderRemoveFile);

module.exports = router;
