const router = require('express').Router();
const ctrl = require('./nriLeads.controller');
const { defaultLimiter } = require('../../middleware/rateLimiter');

router.post('/', defaultLimiter, ctrl.submit);

module.exports = router;
