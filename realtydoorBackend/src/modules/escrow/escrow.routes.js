const router = require('express').Router();
const ctrl = require('./escrow.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');

// Buyer creates escrow order (token advance payment)
router.post('/create-order',    authenticate, requireUser, requirePhone, ctrl.createOrder);
router.post('/verify-payment',  authenticate, requireUser, ctrl.verifyPayment);
router.get('/:id',              authenticate, requireUser, ctrl.getEscrowById);

module.exports = router;
