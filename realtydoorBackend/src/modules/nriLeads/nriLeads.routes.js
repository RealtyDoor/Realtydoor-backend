const router = require('express').Router();
const ctrl = require('./nriLeads.controller');
const { defaultLimiter, publicFormLimiter } = require('../../middleware/rateLimiter');
const honeypot = require('../../middleware/honeypot');

router.post('/', defaultLimiter, publicFormLimiter, honeypot, ctrl.submit);

module.exports = router;
