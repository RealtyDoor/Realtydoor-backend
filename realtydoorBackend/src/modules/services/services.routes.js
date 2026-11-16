const router = require('express').Router();
const ctrl = require('./services.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');
const { paymentStartLimiter, paymentVerifyLimiter } = require('../../middleware/rateLimiter');

router.get('/', ctrl.getAll);
router.post('/create-order',   authenticate, requireUser, requirePhone, paymentStartLimiter, ctrl.createOrder);
router.post('/verify-payment', authenticate, requireUser, paymentVerifyLimiter, ctrl.verifyPayment);

module.exports = router;
