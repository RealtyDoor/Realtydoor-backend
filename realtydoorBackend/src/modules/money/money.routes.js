// Mounted at /api/admin/money (FINANCE permission): ledger, deal money card,
// payables and receivables, reconciliation, TDS ledger, partner tax invoices,
// accountant CSV, audit-chain check.
const router = require('express').Router();
const ctrl = require('./money.controller');
const { requirePermission } = require('../../middleware/requirePermission');
const { validateObjectId } = require('../../middleware/validateObjectId');

router.use(requirePermission('FINANCE'));

router.get('/ledger',                 ctrl.listLedger);
router.post('/ledger/manual',         ctrl.addManual);
router.get('/deals/:leadId',          validateObjectId('leadId'), ctrl.dealCard);
router.get('/payables',               ctrl.payables);
router.get('/profit',                 ctrl.profit);
router.get('/reconcile',              ctrl.reconcile);
router.get('/export',                 ctrl.exportCsv);
router.get('/audit-chain',            ctrl.verifyAudit);

router.get('/tds',                    ctrl.listTds);
router.get('/tds/summary',            ctrl.tdsSummary);
router.post('/tds/deposit',           ctrl.tdsDeposit);
router.post('/tds/return',            ctrl.tdsReturn);
router.post('/tds/form16a',           ctrl.tdsForm16a);

router.get('/tax-invoices',                   ctrl.listInvoices);
router.post('/tax-invoices/:id/accept',       validateObjectId('id'), ctrl.acceptInvoice);
router.post('/tax-invoices/:id/reject',       validateObjectId('id'), ctrl.rejectInvoice);
router.post('/tax-invoices/:id/match',        validateObjectId('id'), ctrl.matchInvoice);

module.exports = router;
