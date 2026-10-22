const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const ApiError = require('../../utils/ApiError');
const { createAuditLog, verifyAuditChain } = require('../../lib/auditLog');
const { buildPartnerStatementPdf } = require('../../lib/pdfReceipt');
const ledger = require('./ledger.service');
const tds = require('./tds.service');
const tax = require('./partnerTax.service');
const v = require('./money.validator');

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

// ─── Admin ───────────────────────────────────────────────────────────────────
const listLedger = wrap(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { data, total } = await ledger.listEntries(req.query, skip, limit);
  success(res, paginate(ledger.withCurrentStatus(data), total, page, limit));
});
const dealCard = wrap(async (req, res) => success(res, await ledger.dealMoneyCard(req.params.leadId)));
const addManual = wrap(async (req, res) => {
  const body = v.manualEntrySchema.parse(req.body);
  const entry = await ledger.addManual(body, req.user.id);
  await createAuditLog({
    adminId: req.user.id, actorRole: 'ADMIN', action: body.type === 'ADJUSTMENT' ? 'LEDGER_ADJUSTMENT' : 'LEDGER_MANUAL_ENTRY',
    targetType: 'MoneyLedgerEntry', targetId: entry.id, after: body, reason: body.reason, ipAddress: req.ip,
  });
  created(res, entry, 'Ledger line added');
});
const payables = wrap(async (req, res) => success(res, await ledger.payablesReceivables()));
const reconcile = wrap(async (req, res) => success(res, await ledger.reconcile()));

// Every export is itself audited, success or not of the download.
const exportCsv = wrap(async (req, res) => {
  const kind = String(req.query.kind || 'ledger');
  const month = String(req.query.month || '');
  const body = await ledger.monthlyCsv(kind, month);
  await createAuditLog({
    adminId: req.user.id, actorRole: 'ADMIN', action: 'MONEY_EXPORT', targetType: 'Export', targetId: `${kind}:${month}`,
    after: { kind, month, bytes: Buffer.byteLength(body) }, ipAddress: req.ip,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="realtydoor-${kind}-${month}.csv"`);
  res.send(`﻿${body}`);
});

const verifyAudit = wrap(async (req, res) => success(res, await verifyAuditChain({ limit: Math.min(Number(req.query.limit) || 5000, 50000) })));

const listTds = wrap(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { data, total, overdueCount } = await tds.list(req.query, skip, limit);
  success(res, { ...paginate(data, total, page, limit), overdueCount });
});
const tdsSummary = wrap(async (req, res) => success(res, await tds.summary(req.query)));
const tdsDeposit = wrap(async (req, res) => { const b = v.depositSchema.parse(req.body); success(res, await tds.recordDeposit(b.ids, b, req.user.id, req.ip), 'Deposit recorded'); });
const tdsReturn = wrap(async (req, res) => { const b = v.returnSchema.parse(req.body); success(res, await tds.recordReturn(b.ids, b, req.user.id, req.ip), 'Return recorded'); });
const tdsForm16a = wrap(async (req, res) => { const b = v.form16aSchema.parse(req.body); success(res, await tds.recordForm16a(b.ids, b, req.user.id, req.ip), 'Form 16A recorded'); });

const listInvoices = wrap(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { data, total } = await tax.listInvoicesAdmin(req.query, skip, limit);
  success(res, paginate(data, total, page, limit));
});
const acceptInvoice = wrap(async (req, res) => success(res, await tax.reviewInvoice(req.params.id, 'ACCEPTED', {}, req.user.id, req.ip), 'Invoice accepted'));
const rejectInvoice = wrap(async (req, res) => {
  const b = v.rejectInvoiceSchema.parse(req.body);
  success(res, await tax.reviewInvoice(req.params.id, 'REJECTED', b, req.user.id, req.ip), 'Invoice rejected');
});
const matchInvoice = wrap(async (req, res) => {
  const b = v.matchInvoiceSchema.parse(req.body || {});
  success(res, await tax.markInvoiceMatched(req.params.id, b, req.user.id, req.ip), 'Invoice marked as matched');
});

// ─── Partner ─────────────────────────────────────────────────────────────────
const uploadInvoice = wrap(async (req, res) => {
  if (!req.file?.path) throw new ApiError(400, 'Attach the invoice file (field "invoice")', { code: 'FILE_REQUIRED' });
  const b = v.uploadInvoiceSchema.parse(req.body);
  created(res, await tax.uploadInvoice(req.user.id, b.leadId, b, req.file.path, req.ip), 'Invoice uploaded for review');
});
const myInvoices = wrap(async (req, res) => success(res, await tax.listInvoicesForPartner(req.user.id)));
const myVouchers = wrap(async (req, res) => success(res, await tax.listVouchersForPartner(req.user.id)));
const voucherOtp = wrap(async (req, res) => success(res, await tax.requestVoucherOtp(req.user.id, req.params.id, req.ip), 'Code sent'));
const voucherAccept = wrap(async (req, res) => {
  const b = v.voucherAcceptSchema.parse(req.body);
  success(res, tax.publicVoucher(await tax.acceptVoucher(req.user.id, req.params.id, b.code, req.ip)), 'Voucher accepted');
});
const myStatements = wrap(async (req, res) => success(res, await tax.listStatements(req.user.id)));
const myStatement = wrap(async (req, res) => success(res, await tax.buildStatement(req.user.id, req.params.escrowId)));
const myStatementPdf = wrap(async (req, res) => {
  const st = await tax.buildStatement(req.user.id, req.params.escrowId);
  const pdf = await buildPartnerStatementPdf(st);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="commission-statement-${req.params.escrowId}.pdf"`);
  res.send(pdf);
});

module.exports = {
  listLedger, dealCard, addManual, payables, reconcile, exportCsv, verifyAudit,
  listTds, tdsSummary, tdsDeposit, tdsReturn, tdsForm16a,
  listInvoices, acceptInvoice, rejectInvoice, matchInvoice,
  uploadInvoice, myInvoices, myVouchers, voucherOtp, voucherAccept, myStatements, myStatement, myStatementPdf,
};
