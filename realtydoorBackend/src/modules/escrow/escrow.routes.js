const router = require('express').Router();
const ctrl = require('./escrow.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { requirePhone } = require('../../middleware/requirePhone');
const { validateObjectId } = require('../../middleware/validateObjectId');
const { documentLimiter } = require('../../middleware/rateLimiter');

// Public price breakdown (token + processing fee + refund terms). Before /:id.
router.get('/quote',            ctrl.getCheckoutQuote);

// Buyer creates escrow order (token advance payment)
router.post('/create-order',    authenticate, requireUser, requirePhone, ctrl.createOrder);
router.post('/verify-payment',  authenticate, requireUser, ctrl.verifyPayment);
router.get('/:id',              authenticate, requireUser, validateObjectId('id'), ctrl.getEscrowById);
// Dev feedback, 2026-10-08 — registered after /:id is fine here since
// Express only falls through to /:id/receipt if the path actually has
// that extra segment; a bare /:id request never reaches this route.
router.get('/:id/receipt',      authenticate, requireUser, validateObjectId('id'), documentLimiter, ctrl.getReceipt);
// BUG-M11 — refund receipt, only for a refunded payment (400 otherwise).
router.get('/:id/refund-receipt', authenticate, requireUser, validateObjectId('id'), documentLimiter, ctrl.getRefundReceipt);
// T62 — GST tax invoice for the processing fee (409 FEE_INVOICE_UNAVAILABLE until the company GSTIN is set).
router.get('/:id/fee-invoice',  authenticate, requireUser, validateObjectId('id'), documentLimiter, ctrl.getFeeInvoice);

module.exports = router;
