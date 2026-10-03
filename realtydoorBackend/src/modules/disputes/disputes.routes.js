const router = require('express').Router();
const ctrl = require('./disputes.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { perUserLimiter } = require('../../middleware/rateLimiter');

router.use(authenticate, requireUser, perUserLimiter);

router.post('/', ctrl.raiseDispute);
router.get('/', ctrl.getMyDisputes);

module.exports = router;
