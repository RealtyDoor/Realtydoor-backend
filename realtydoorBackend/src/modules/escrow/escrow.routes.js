const router = require('express').Router();
const ctrl = require('./escrow.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');

// Buyer creates escrow order (token advance payment)
router.post('/create-order',    authenticate, requireUser, requirePhone, ctrl.createOrder);
router.post('/verify-payment',  authenticate, requireUser, ctrl.verifyPayment);
router.get('/:id',              authenticate, requireUser, ctrl.getEscrowById);
// Dev feedback, 2026-10-08 — registered after /:id is fine here since
// Express only falls through to /:id/receipt if the path actually has
// that extra segment; a bare /:id request never reaches this route.
router.get('/:id/receipt',      authenticate, requireUser, ctrl.getReceipt);

module.exports = router;
