'use strict';

// Append-only money ledger (money model Rev 3, phase 2). Every amount is
// integer paise. Rows are only ever created (lib/immutability.js refuses
// edits). Emitters below are called from the escrow, commission and webhook
// code at the moment money moves; they never throw into the money flow (see
// recordSafe) but log loudly, and the reconciliation view shows any gap.
// Spec: admin-nextjs/docs/MONEY_LEDGER_SPEC_DRAFT.md.

const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const money = require('../../lib/moneyModel');

const LEDGER_TYPES = [
  'TOKEN_IN', 'PROCESSING_FEE_IN', 'GATEWAY_FEE', 'SETTLEMENT_IN',
  'SELLER_PAYOUT', 'PARTNER_COMMISSION', 'COMMISSION_VOUCHER',
  'TDS_WITHHELD', 'TDS_DEPOSITED', 'TDS_RECEIVABLE',
  'CANCELLATION_CHARGE', 'GST_OUTPUT', 'GST_INPUT', 'GST_INPUT_PENDING',
  'BROKERAGE_INVOICED', 'BROKERAGE_RECEIVED', 'REFUND',
  'PAYOUT_FEE', 'SERVICE_REVENUE', 'VENDOR_PAYMENT', 'ADJUSTMENT',
];
const DIRECTIONS = ['IN', 'OUT', 'NONE'];
const STATUSES = ['DUE', 'PAID', 'FAILED', 'REVERSED', 'PENDING_INVOICE', 'MATCHED', 'RECORDED'];
const PARTY_TYPES = ['BUYER', 'SELLER', 'PARTNER', 'VENDOR', 'GOVERNMENT', 'RAZORPAY', 'REALTYDOOR'];

// Types an admin may enter by hand. Only ADJUSTMENT is free-form (with a
// reason); the others record an off-platform fact the app cannot see.
const MANUAL_TYPES = ['ADJUSTMENT', 'GATEWAY_FEE', 'SETTLEMENT_IN', 'PAYOUT_FEE', 'VENDOR_PAYMENT', 'TDS_RECEIVABLE'];

function validate(e) {
  if (!LEDGER_TYPES.includes(e.type)) throw new ApiError(400, `Unknown ledger type "${e.type}"`);
  if (!DIRECTIONS.includes(e.direction)) throw new ApiError(400, `direction must be one of ${DIRECTIONS.join(', ')}`);
  if (e.status && !STATUSES.includes(e.status)) throw new ApiError(400, `Unknown status "${e.status}"`);
  if (!PARTY_TYPES.includes(e.partyType)) throw new ApiError(400, `Unknown partyType "${e.partyType}"`);
  for (const f of ['grossPaise', 'netPaise']) {
    if (!Number.isInteger(e[f])) throw new ApiError(400, `${f} must be an integer number of paise`);
  }
  for (const f of ['gstPaise', 'tdsPaise', 'feePaise']) {
    if (e[f] != null && !Number.isInteger(e[f])) throw new ApiError(400, `${f} must be an integer number of paise`);
  }
  if (!e.idempotencyKey) throw new ApiError(400, 'idempotencyKey is required');
  if (!e.createdByType) throw new ApiError(400, 'createdByType is required');
  if (e.type === 'ADJUSTMENT' && !e.reason?.trim()) throw new ApiError(400, 'An ADJUSTMENT needs a reason', { code: 'REASON_REQUIRED' });
}

// Creates one row, once per idempotencyKey (a retry returns the first row).
async function record(entry) {
  validate(entry);
  const existing = await prisma.moneyLedgerEntry.findUnique({ where: { idempotencyKey: entry.idempotencyKey } });
  if (existing) return existing;
  try {
    return await prisma.moneyLedgerEntry.create({
      data: {
        status: 'RECORDED', gstPaise: 0, tdsPaise: 0, feePaise: 0, ...entry,
        entryDate: entry.entryDate || new Date(),
      },
    });
  } catch (err) {
    // The unique index (once applied) closes the race between the find and create.
    if (err.code === 'P2002') return prisma.moneyLedgerEntry.findUnique({ where: { idempotencyKey: entry.idempotencyKey } });
    throw err;
  }
}

// Used by the money flows: a ledger write problem must not undo a payment or a
// payout that already happened, but it must not be silent either.
async function recordSafe(entry) {
  try {
    return await record(entry);
  } catch (err) {
    logger.error('[Ledger] FAILED to record a ledger entry — reconcile this deal by hand', {
      type: entry.type, escrowId: entry.escrowId, key: entry.idempotencyKey, error: err.message,
    });
    return null;
  }
}

const sys = { createdByType: 'SYSTEM' };

// ─── Emitters ────────────────────────────────────────────────────────────────

// Token and processing fee captured. The fee line carries the GST inside it.
async function onPaymentCaptured(escrow, { feeGstPct = 18 } = {}) {
  const tokenPaise = Math.round(escrow.amount * 100);
  const feePaise = escrow.processingFeePaise ?? 0;
  const base = { leadId: escrow.leadId, escrowId: escrow.id, partyType: 'BUYER', partyId: escrow.buyerId, direction: 'IN', razorpayPaymentId: escrow.razorpayPaymentId, ...sys };
  await recordSafe({ ...base, type: 'TOKEN_IN', status: 'RECORDED', grossPaise: tokenPaise, netPaise: tokenPaise, idempotencyKey: `tokenIn:${escrow.id}`, note: 'Token held in escrow (a liability, not income)' });
  if (feePaise > 0) {
    const gst = feePaise - Math.round(feePaise / (1 + feeGstPct / 100));
    await recordSafe({ ...base, type: 'PROCESSING_FEE_IN', grossPaise: feePaise, gstPaise: gst, netPaise: feePaise - gst, idempotencyKey: `feeIn:${escrow.id}`, note: 'Payment processing fee, GST inside' });
  }
}

// A refund went out: the money back, and the cancellation charge kept.
async function onRefund(escrow, quote, { refundId, actor }) {
  const by = actor || sys;
  await recordSafe({
    leadId: escrow.leadId, escrowId: escrow.id, type: 'REFUND', direction: 'OUT', status: 'RECORDED',
    partyType: 'BUYER', partyId: escrow.buyerId, grossPaise: quote.refundPaise, netPaise: quote.refundPaise,
    razorpayPaymentId: escrow.razorpayPaymentId, razorpayRefundId: refundId, reason: quote.reason,
    note: quote.feeReturned ? 'Token and processing fee returned' : 'Token returned, processing fee kept',
    idempotencyKey: `refund:${escrow.id}:${refundId}`, ...by,
  });
  if (quote.cancellationChargePaise > 0) {
    const sp = quote.cancellationSplit;
    await recordSafe({
      leadId: escrow.leadId, escrowId: escrow.id, type: 'CANCELLATION_CHARGE', direction: 'NONE', status: 'RECORDED',
      partyType: 'BUYER', partyId: escrow.buyerId, grossPaise: sp.chargePaise, gstPaise: sp.gstOnRealtydoorPaise, netPaise: sp.chargePaise - sp.gstOnRealtydoorPaise,
      note: `Kept from the refund: Realtydoor ${sp.realtydoorPaise}p (GST inside ${sp.gstOnRealtydoorPaise}p), seller ${sp.sellerPaise}p [split and GST: CA]`,
      idempotencyKey: `cancelCharge:${escrow.id}`, ...by,
    });
  }
}

// Seller leg of a release.
async function onSellerPayout(escrow, { sellerAmountPaise, payoutId, status }) {
  const due = await recordSafe({
    leadId: escrow.leadId, escrowId: escrow.id, type: 'SELLER_PAYOUT', direction: 'OUT', status: 'DUE',
    partyType: 'SELLER', grossPaise: sellerAmountPaise, netPaise: sellerAmountPaise, razorpayPayoutId: payoutId || null,
    note: payoutId ? `Payout ${status || ''}`.trim() : 'Paid outside Razorpay (manual transfer)',
    idempotencyKey: `sellerPayout:${escrow.id}`, ...sys,
  });
  // A RazorpayX payout is settled later by its webhook (onPayoutStatus). A transfer the admin confirms as already
  // made outside Razorpay has no webhook, so settle it here: otherwise "Seller payouts due" keeps showing it forever.
  if (!payoutId && due) {
    await recordSafe({
      leadId: escrow.leadId, escrowId: escrow.id, type: 'SELLER_PAYOUT', direction: 'OUT', status: 'PAID',
      partyType: 'SELLER', grossPaise: sellerAmountPaise, netPaise: sellerAmountPaise, relatedEntryId: due.id,
      note: 'Paid outside Razorpay (manual transfer), confirmed by admin',
      idempotencyKey: `sellerPayoutManual:${escrow.id}`, ...sys,
    });
  }
  return due;
}

// The partner's commission was credited (and normally paid). Registered
// partner: PARTNER_COMMISSION against a tax invoice. Unregistered:
// COMMISSION_VOUCHER. Also TDS_WITHHELD, and GST_INPUT_PENDING when the
// partner is registered. Returns the commission entry (the payout row).
async function onPartnerCredit(escrow, c, { tdsEntryId, voucherId, taxInvoiceId, invoiceNumber, payoutId, payoutStatus, partnerName }) {
  const base = { leadId: escrow.leadId, escrowId: escrow.id, partyType: 'PARTNER', partyId: c.partnerId, partyName: partnerName || c.partnerName, ...sys };
  const commission = await recordSafe({
    ...base, type: c.gstRegistered ? 'PARTNER_COMMISSION' : 'COMMISSION_VOUCHER', direction: 'OUT', status: 'DUE',
    grossPaise: c.commissionPaise, tdsPaise: c.tdsPaise, netPaise: c.commissionPaise - c.tdsPaise,
    razorpayPayoutId: payoutId || null, voucherId: voucherId || null, taxInvoiceId: taxInvoiceId || null, invoiceNumber: invoiceNumber || null,
    tdsEntryId: tdsEntryId || null,
    note: payoutId ? `Commission payout ${payoutStatus || ''}`.trim() : 'Commission credited, payout pending',
    idempotencyKey: `partnerCredit:${escrow.id}`,
  });
  if (c.tdsPaise > 0) {
    await recordSafe({
      ...base, type: 'TDS_WITHHELD', direction: 'NONE', status: 'DUE', partyType: 'GOVERNMENT', partyName: 'Income-tax department (TDS payable)',
      grossPaise: c.tdsPaise, netPaise: c.tdsPaise, tdsEntryId: tdsEntryId || null,
      note: `Withheld from ${partnerName || c.partnerName || 'partner'} at ${c.tdsRatePct}% (${c.tdsSection}); deposit by the due date`,
      idempotencyKey: `tdsWithheld:${escrow.id}`,
    });
  }
  if (c.gstRegistered && c.gstPendingPaise > 0) {
    await recordSafe({
      ...base, type: 'GST_INPUT_PENDING', direction: 'NONE', status: 'PENDING_INVOICE',
      grossPaise: c.gstPendingPaise, gstPaise: c.gstPendingPaise, netPaise: c.gstPendingPaise,
      taxInvoiceId: taxInvoiceId || null, invoiceNumber: invoiceNumber || null,
      note: 'Partner GST held back until the tax invoice shows in our GSTR-2B',
      idempotencyKey: `gstPending:${escrow.id}`,
    });
  }
  return commission;
}

// A payout reached a new state at RazorpayX (processed / failed / reversed).
// Written as a NEW row pointing at the original; the original is never edited.
async function onPayoutStatus({ escrowId, payoutId, status, utr, reason }) {
  const parent = await prisma.moneyLedgerEntry.findFirst({
    where: { razorpayPayoutId: payoutId, type: { in: ['SELLER_PAYOUT', 'PARTNER_COMMISSION', 'COMMISSION_VOUCHER'] }, relatedEntryId: { isSet: false } },
  });
  if (!parent) {
    logger.warn('[Ledger] payout status for a payout with no ledger row', { escrowId, payoutId, status });
    return null;
  }
  const mapped = { processed: 'PAID', failed: 'FAILED', rejected: 'FAILED', reversed: 'REVERSED', cancelled: 'FAILED' }[status];
  if (!mapped) return null;
  return recordSafe({
    leadId: parent.leadId, escrowId: parent.escrowId, type: parent.type,
    direction: mapped === 'PAID' ? 'OUT' : 'NONE', status: mapped,
    partyType: parent.partyType, partyId: parent.partyId, partyName: parent.partyName,
    grossPaise: parent.grossPaise, tdsPaise: parent.tdsPaise, netPaise: parent.netPaise,
    razorpayPayoutId: payoutId, utr: utr || null, relatedEntryId: parent.id,
    reason: reason || null, note: `Payout ${status}${utr ? ` (UTR ${utr})` : ''}`,
    idempotencyKey: `payoutStatus:${payoutId}:${mapped}`, ...sys, createdByType: 'WEBHOOK',
  });
}

// Brokerage invoiced to the seller / developer, and later received.
async function onBrokerageInvoiced(lead, inv, { adminId }) {
  return recordSafe({
    leadId: lead.id, type: 'BROKERAGE_INVOICED', direction: 'NONE', status: 'DUE', partyType: 'SELLER', partyId: lead.sellerId || null,
    grossPaise: inv.subtotalPaise, gstPaise: inv.gstPaise, netPaise: inv.totalPaise,
    invoiceNumber: lead.invoiceNumber || null,
    note: `Partner ${inv.partnerPaise}p + platform fee ${inv.platformPaise}p + GST on the whole`,
    idempotencyKey: `brokerageInvoiced:${lead.id}`, createdByType: 'ADMIN', createdById: adminId,
  });
}

async function onBrokerageReceived(lead, inv, { adminId, tdsDeductedPaise = 0 }) {
  const row = await recordSafe({
    leadId: lead.id, type: 'BROKERAGE_RECEIVED', direction: 'IN', status: 'PAID', partyType: 'SELLER', partyId: lead.sellerId || null,
    grossPaise: inv.subtotalPaise, gstPaise: inv.gstPaise, tdsPaise: tdsDeductedPaise, netPaise: inv.totalPaise - tdsDeductedPaise,
    idempotencyKey: `brokerageReceived:${lead.id}`, createdByType: 'ADMIN', createdById: adminId,
    note: tdsDeductedPaise ? 'Seller deducted TDS on our fee (see TDS_RECEIVABLE)' : null,
  });
  return row;
}

async function onTdsDeposited(entry, { adminId }) {
  return recordSafe({
    leadId: entry.leadId, escrowId: entry.escrowId, type: 'TDS_DEPOSITED', direction: 'OUT', status: 'PAID',
    partyType: 'GOVERNMENT', partyName: 'Income-tax department', grossPaise: entry.tdsPaise, netPaise: entry.tdsPaise, tdsEntryId: entry.id,
    invoiceNumber: entry.challanNumber || null, note: `Challan ${entry.challanNumber || ''} BSR ${entry.bsrCode || ''}`.trim(),
    idempotencyKey: `tdsDeposited:${entry.id}`, createdByType: 'ADMIN', createdById: adminId,
  });
}

// GST input credit is claimed when the partner's invoice is matched in GSTR-2B.
async function onInvoiceMatched(inv, { adminId }) {
  const gst = inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
  await recordSafe({
    leadId: inv.leadId, escrowId: inv.escrowId || null, type: 'GST_INPUT', direction: 'NONE', status: 'MATCHED',
    partyType: 'PARTNER', partyId: inv.partnerId, grossPaise: gst, gstPaise: gst, netPaise: gst,
    taxInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, note: `Matched in GSTR-2B ${inv.gstr2bPeriod || ''}`.trim(),
    idempotencyKey: `gstInput:${inv.id}`, createdByType: 'ADMIN', createdById: adminId,
  });
  const pending = await prisma.moneyLedgerEntry.findFirst({ where: { type: 'GST_INPUT_PENDING', leadId: inv.leadId, relatedEntryId: { isSet: false } } });
  if (pending) {
    await recordSafe({
      leadId: pending.leadId, escrowId: pending.escrowId, type: 'GST_INPUT_PENDING', direction: 'NONE', status: 'MATCHED',
      partyType: pending.partyType, partyId: pending.partyId, partyName: pending.partyName,
      grossPaise: pending.grossPaise, gstPaise: pending.gstPaise, netPaise: pending.netPaise,
      taxInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, relatedEntryId: pending.id,
      note: 'Invoice matched: the GST part can now be paid to the partner',
      idempotencyKey: `gstPendingMatched:${pending.id}`, createdByType: 'ADMIN', createdById: adminId,
    });
  }
}

// Admin-entered lines. ADJUSTMENT needs a reason and may reverse an earlier row.
async function addManual(input, adminId) {
  if (!MANUAL_TYPES.includes(input.type)) {
    throw new ApiError(400, `Only ${MANUAL_TYPES.join(', ')} can be entered by hand; the other types are written by the system`);
  }
  if (!input.reason?.trim()) throw new ApiError(400, 'A reason is required for a manual ledger line', { code: 'REASON_REQUIRED' });
  let reverses = null;
  if (input.reversesEntryId) {
    reverses = await prisma.moneyLedgerEntry.findUnique({ where: { id: input.reversesEntryId } });
    if (!reverses) throw new ApiError(404, 'The entry to reverse was not found');
    const done = await prisma.moneyLedgerEntry.findFirst({ where: { reversesEntryId: reverses.id } });
    if (done) throw new ApiError(409, 'That entry was already reversed', { code: 'ALREADY_REVERSED' });
  }
  return record({
    type: input.type, direction: input.direction, status: 'RECORDED',
    partyType: input.partyType, partyName: input.partyName || null,
    leadId: input.leadId || reverses?.leadId || null, escrowId: input.escrowId || reverses?.escrowId || null,
    grossPaise: input.grossPaise, gstPaise: input.gstPaise || 0, tdsPaise: input.tdsPaise || 0, feePaise: input.feePaise || 0,
    netPaise: input.netPaise ?? input.grossPaise - (input.tdsPaise || 0) - (input.feePaise || 0),
    razorpaySettlementId: input.razorpaySettlementId || null, utr: input.utr || null, invoiceNumber: input.invoiceNumber || null,
    reversesEntryId: reverses?.id || null, reason: input.reason.trim(), note: input.note || null,
    entryDate: input.entryDate ? new Date(input.entryDate) : new Date(),
    idempotencyKey: input.idempotencyKey || `manual:${adminId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'ADMIN', createdById: adminId,
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

function buildWhere(f = {}) {
  const where = {};
  if (f.leadId) where.leadId = f.leadId;
  if (f.escrowId) where.escrowId = f.escrowId;
  if (f.type) where.type = Array.isArray(f.type) ? { in: f.type } : f.type;
  if (f.status) where.status = f.status;
  if (f.partyType) where.partyType = f.partyType;
  if (f.partyId) where.partyId = f.partyId;
  if (f.from || f.to) {
    where.entryDate = {};
    if (f.from) where.entryDate.gte = new Date(f.from);
    if (f.to) where.entryDate.lte = new Date(f.to);
  }
  return where;
}

async function listEntries(filters, skip, limit) {
  const where = buildWhere(filters);
  const [data, total] = await Promise.all([
    prisma.moneyLedgerEntry.findMany({ where, skip, take: limit, orderBy: { entryDate: 'desc' } }),
    prisma.moneyLedgerEntry.count({ where }),
  ]);
  return { data, total };
}

// The current state of an original row = the newest later row that points at it.
function withCurrentStatus(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const latest = new Map();
  for (const r of rows) {
    const parent = r.relatedEntryId && byId.get(r.relatedEntryId);
    if (!parent || parent.type !== r.type) continue; // only same-type rows are status updates
    const prev = latest.get(r.relatedEntryId);
    if (!prev || new Date(r.entryDate) >= new Date(prev.entryDate)) latest.set(r.relatedEntryId, r);
  }
  return rows.map((r) => ({ ...r, currentStatus: latest.get(r.id)?.status ?? r.status }));
}

// One deal, every rupee in and out.
async function dealMoneyCard(leadId) {
  const [lead, escrows, entries, tds, invoices, vouchers] = await Promise.all([
    prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, refCode: true, buyerName: true, feePct: true, dealPriceAtLock: true, partnerRatePct: true, platformFeePct: true, commissionStatus: true, assignedPartnerId: true, commissionRateCustom: true },
    }),
    prisma.escrowTransaction.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } }),
    prisma.moneyLedgerEntry.findMany({ where: { leadId }, orderBy: { entryDate: 'asc' } }),
    prisma.tdsEntry.findMany({ where: { leadId } }),
    prisma.partnerTaxInvoice.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' } }),
    prisma.commissionVoucher.findMany({ where: { leadId } }),
  ]);
  if (!lead) throw new ApiError(404, 'Lead not found');
  const rows = withCurrentStatus(entries);
  const sum = (types, pick = 'grossPaise', pred = () => true) =>
    rows.filter((r) => types.includes(r.type) && !r.relatedEntryId && pred(r)).reduce((s, r) => s + r[pick], 0);

  const tokenIn = sum(['TOKEN_IN']);
  const feeIn = sum(['PROCESSING_FEE_IN']);
  const refunds = sum(['REFUND']);
  const cancelCharge = sum(['CANCELLATION_CHARGE']);
  const sellerPaid = sum(['SELLER_PAYOUT'], 'netPaise');
  const partnerGross = sum(['PARTNER_COMMISSION', 'COMMISSION_VOUCHER']);
  const partnerTds = sum(['PARTNER_COMMISSION', 'COMMISSION_VOUCHER'], 'tdsPaise');
  const partnerNet = sum(['PARTNER_COMMISSION', 'COMMISSION_VOUCHER'], 'netPaise');
  const gstPending = sum(['GST_INPUT_PENDING'], 'grossPaise');
  const invoiced = sum(['BROKERAGE_INVOICED'], 'netPaise');
  const received = sum(['BROKERAGE_RECEIVED'], 'netPaise');
  const tdsReceivable = sum(['TDS_RECEIVABLE']);
  const gatewayFee = sum(['GATEWAY_FEE']);
  const heldPaise = escrows.filter((e) => ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'].includes(e.status)).reduce((s, e) => s + Math.round(e.amount * 100), 0);

  return {
    lead: { ...lead },
    escrows: escrows.map((e) => ({ id: e.id, status: e.status, tokenPaise: Math.round(e.amount * 100), processingFeePaise: e.processingFeePaise ?? 0, chargedPaise: e.chargedPaise ?? null, heldAt: e.heldAt, releasedAt: e.releasedAt, refundedAt: e.refundedAt, refundReason: e.refundReason ?? null })),
    summary: {
      cashIn: { tokenPaise: tokenIn, processingFeePaise: feeIn, brokerageReceivedPaise: received },
      cashOut: { refundsPaise: refunds, sellerPayoutPaise: sellerPaid, partnerNetPaise: partnerNet, gatewayFeePaise: gatewayFee },
      heldInEscrowPaise: heldPaise,
      partner: { commissionPaise: partnerGross, tdsPaise: partnerTds, netPaise: partnerNet, gstPendingPaise: gstPending },
      brokerage: { invoicedPaise: invoiced, receivedPaise: received, outstandingPaise: Math.max(0, invoiced - received), tdsReceivablePaise: tdsReceivable },
      cancellationChargePaise: cancelCharge,
    },
    tds: tds.map((t) => ({ id: t.id, tdsPaise: t.tdsPaise, ratePct: t.ratePct, section: t.section, depositedAt: t.depositedAt, depositDueDate: t.depositDueDate })),
    taxInvoices: invoices.map((i) => ({ id: i.id, status: i.status, invoiceNumber: i.invoiceNumber, totalPaise: i.totalPaise, fileUrl: i.fileUrl })),
    vouchers: vouchers.map((v) => ({ id: v.id, voucherNumber: v.voucherNumber, status: v.status, netPaise: v.netPaise, acceptedAt: v.acceptedAt })),
    entries: rows,
  };
}

// What we owe, and what is owed to us.
async function payablesReceivables(now = new Date()) {
  const [credits, gstPend, tdsOpen, sellers, invoiced, tdsRecv, escrowsHeld] = await Promise.all([
    prisma.moneyLedgerEntry.findMany({ where: { type: { in: ['PARTNER_COMMISSION', 'COMMISSION_VOUCHER'] } } }),
    prisma.moneyLedgerEntry.findMany({ where: { type: 'GST_INPUT_PENDING' } }),
    prisma.tdsEntry.findMany({ where: { depositedAt: { isSet: false }, tdsPaise: { gt: 0 } } }),
    prisma.moneyLedgerEntry.findMany({ where: { type: 'SELLER_PAYOUT' } }),
    prisma.moneyLedgerEntry.findMany({ where: { type: { in: ['BROKERAGE_INVOICED', 'BROKERAGE_RECEIVED'] } } }),
    prisma.moneyLedgerEntry.findMany({ where: { type: 'TDS_RECEIVABLE' } }),
    prisma.escrowTransaction.findMany({ where: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN'] } }, select: { amount: true } }),
  ]);
  const open = (rows) => withCurrentStatus(rows).filter((r) => !r.relatedEntryId && ['DUE', 'RECORDED'].includes(r.currentStatus));
  const sumNet = (rows) => rows.reduce((s, r) => s + r.netPaise, 0);

  const partnerDue = open(credits);
  const sellerDue = open(sellers).filter((r) => r.status === 'DUE');
  // GST: pending until the invoice is matched; once matched it is payable to the partner until a PAID row appears.
  const gstRows = withCurrentStatus(gstPend).filter((r) => !r.relatedEntryId);
  const gstAwaiting = gstRows.filter((r) => r.currentStatus === 'PENDING_INVOICE');
  const gstPayable = gstRows.filter((r) => r.currentStatus === 'MATCHED');

  const overdue = tdsOpen.filter((t) => t.depositDueDate && new Date(t.depositDueDate) < now);
  const invByLead = new Map();
  for (const r of invoiced) {
    const cur = invByLead.get(r.leadId) || { invoiced: 0, received: 0 };
    if (r.type === 'BROKERAGE_INVOICED') cur.invoiced += r.netPaise; else cur.received += r.netPaise;
    invByLead.set(r.leadId, cur);
  }
  const brokerageOutstanding = [...invByLead.entries()].map(([leadId, v]) => ({ leadId, outstandingPaise: v.invoiced - v.received })).filter((x) => x.outstandingPaise > 0);

  return {
    asOf: now,
    payables: {
      partnerCommissionPaise: sumNet(partnerDue), partnerCommissionCount: partnerDue.length,
      sellerPayoutsPaise: sumNet(sellerDue), sellerPayoutsCount: sellerDue.length,
      partnerGstAwaitingInvoicePaise: sumNet(gstAwaiting), partnerGstPayableAfterMatchPaise: sumNet(gstPayable),
      tdsToDepositPaise: tdsOpen.reduce((s, t) => s + t.tdsPaise, 0), tdsToDepositCount: tdsOpen.length,
      tdsOverduePaise: overdue.reduce((s, t) => s + t.tdsPaise, 0), tdsOverdueCount: overdue.length,
    },
    receivables: {
      brokerageOutstandingPaise: brokerageOutstanding.reduce((s, x) => s + x.outstandingPaise, 0),
      brokerageOutstandingDeals: brokerageOutstanding,
      tdsReceivablePaise: tdsRecv.reduce((s, r) => s + r.netPaise, 0),
    },
    heldForOthers: { tokensInEscrowPaise: escrowsHeld.reduce((s, e) => s + Math.round(e.amount * 100), 0), count: escrowsHeld.length },
  };
}

// Internal tally of the ledger against the escrow rows. (A comparison with
// Razorpay's own settlement and payout reports needs their API and is not part
// of this phase: razorpay.status says so.)
async function reconcile() {
  const escrows = await prisma.escrowTransaction.findMany({
    where: { status: { notIn: ['PAYMENT_PENDING', 'CANCELLED', 'FAILED'] } },
    select: { id: true, leadId: true, amount: true, amountPaise: true, processingFeePaise: true, status: true, refundedAmountPaise: true, netAmountPaise: true, razorpayPayoutId: true },
  });
  const rows = await prisma.moneyLedgerEntry.findMany({ where: { escrowId: { in: escrows.map((e) => e.id) }, relatedEntryId: { isSet: false } } });
  const byEscrow = new Map();
  for (const r of rows) {
    const m = byEscrow.get(r.escrowId) || {};
    m[r.type] = (m[r.type] || 0) + r.grossPaise;
    byEscrow.set(r.escrowId, m);
  }
  const differences = [];
  for (const e of escrows) {
    const m = byEscrow.get(e.id) || {};
    const token = e.amountPaise ?? Math.round(e.amount * 100);
    const check = (what, expected, got) => { if (expected !== got) differences.push({ escrowId: e.id, leadId: e.leadId, what, expectedPaise: expected, ledgerPaise: got }); };
    check('TOKEN_IN', token, m.TOKEN_IN || 0);
    if (e.processingFeePaise) check('PROCESSING_FEE_IN', e.processingFeePaise, m.PROCESSING_FEE_IN || 0);
    if (e.refundedAmountPaise) check('REFUND', e.refundedAmountPaise, m.REFUND || 0);
    if (e.status === 'RELEASED' && e.netAmountPaise) check('SELLER_PAYOUT', e.netAmountPaise, m.SELLER_PAYOUT || 0);
  }
  return {
    checked: escrows.length, tallied: differences.length === 0, differences,
    razorpay: { status: 'NOT_RUN', note: 'Comparison with Razorpay settlements and payouts is not built yet.' },
  };
}

// Income against costs from the ledger for a period (money model Rev 3, ledger
// spec section 2.7). Only what the ledger knows: lines nobody has entered (for
// example gateway fees, which come from Razorpay settlements) are zero here, and
// the response says so. Amounts in paise, GST excluded from income.
async function profitView({ from, to }) {
  const where = { entryDate: {} };
  if (from) where.entryDate.gte = new Date(from);
  if (to) where.entryDate.lte = new Date(to);
  const rows = await prisma.moneyLedgerEntry.findMany({ where: Object.keys(where.entryDate).length ? where : {} });
  const base = rows.filter((r) => !r.relatedEntryId);
  const sum = (types, pick = 'grossPaise') => base.filter((r) => types.includes(r.type)).reduce((s, r) => s + r[pick], 0);
  const reversed = new Set(base.filter((r) => r.reversesEntryId).map((r) => r.reversesEntryId));
  const net = (types, pick = 'grossPaise') => base.filter((r) => types.includes(r.type) && !reversed.has(r.id)).reduce((s, r) => s + r[pick], 0);

  const brokerageExGst = net(['BROKERAGE_RECEIVED']);
  const partnerCommission = net(['PARTNER_COMMISSION', 'COMMISSION_VOUCHER']);
  const income = {
    brokerageExGstPaise: brokerageExGst,
    processingFeeExGstPaise: net(['PROCESSING_FEE_IN'], 'netPaise'),
    cancellationChargeExGstPaise: net(['CANCELLATION_CHARGE'], 'netPaise'),
    serviceRevenuePaise: net(['SERVICE_REVENUE'], 'netPaise'),
  };
  const costs = {
    partnerCommissionPaise: partnerCommission,
    gatewayFeePaise: net(['GATEWAY_FEE']),
    payoutFeePaise: net(['PAYOUT_FEE']),
    vendorPaymentPaise: net(['VENDOR_PAYMENT']),
  };
  const adjustments = base.filter((r) => r.type === 'ADJUSTMENT').reduce((s, r) => s + (r.direction === 'IN' ? r.netPaise : r.direction === 'OUT' ? -r.netPaise : 0), 0);
  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0);
  void sum;
  return {
    from: from || null, to: to || null, income, costs, adjustmentsPaise: adjustments,
    totalIncomePaise: totalIncome, totalCostsPaise: totalCosts, profitPaise: totalIncome - totalCosts + adjustments,
    entries: base.length,
    notes: [
      'Income excludes GST. Tokens held in escrow are a liability, not income.',
      'Gateway and payout fees appear only once they are entered or imported; until then profit is overstated by that amount.',
    ],
  };
}

// ─── CSV (Tally-ready columns) ───────────────────────────────────────────────

// Cells that start with = + - @ would be run as a formula by a spreadsheet.
// A plain number (a negative amount such as -120.00, or a +91 phone number) is not a formula, so it is left alone: prefixing it would
// turn the accountant's amounts into text.
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (headers, records) => [headers.join(','), ...records.map((r) => r.map(csvCell).join(','))].join('\r\n');
const rupees = (p) => (p == null ? '' : (p / 100).toFixed(2));
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m || +m[2] < 1 || +m[2] > 12) throw new ApiError(400, 'month must look like 2026-10');
  const from = new Date(Date.UTC(+m[1], +m[2] - 1, 1) - 5.5 * 3600e3); // IST month
  const to = new Date(Date.UTC(+m[1], +m[2], 1) - 5.5 * 3600e3);
  return { from, to };
}

async function monthlyCsv(kind, month) {
  const { from, to } = monthRange(month);
  const dateWhere = { gte: from, lt: to };
  if (kind === 'ledger') {
    const rows = await prisma.moneyLedgerEntry.findMany({ where: { entryDate: dateWhere }, orderBy: { entryDate: 'asc' } });
    return csv(
      ['Date', 'Entry id', 'Type', 'Deal id', 'Party type', 'Party', 'Direction', 'Gross', 'GST', 'TDS', 'Fee', 'Net', 'Status', 'Payment id', 'Payout id', 'Refund id', 'UTR', 'Invoice no', 'Related entry', 'Reverses', 'Reason', 'Note'],
      rows.map((r) => [ymd(r.entryDate), r.id, r.type, r.leadId, r.partyType, r.partyName || r.partyId, r.direction, rupees(r.grossPaise), rupees(r.gstPaise), rupees(r.tdsPaise), rupees(r.feePaise), rupees(r.netPaise), r.status, r.razorpayPaymentId, r.razorpayPayoutId, r.razorpayRefundId, r.utr, r.invoiceNumber, r.relatedEntryId, r.reversesEntryId, r.reason, r.note]),
    );
  }
  if (kind === 'tds') {
    const rows = await prisma.tdsEntry.findMany({ where: { deductedAt: dateWhere }, orderBy: { deductedAt: 'asc' } });
    return csv(
      ['Deducted on', 'Partner id', 'PAN', 'FY', 'Quarter', 'Section', 'Rate %', 'Reason', 'Commission (ex GST)', 'Year to date before', 'Threshold', 'TDS', 'Net paid', 'Deposit due', 'Deposited on', 'Challan', 'BSR', 'Return quarter', 'Return filed', 'Form 16A issued', 'Deal id'],
      rows.map((t) => [ymd(t.deductedAt), t.partnerId, t.panAtDeduction, t.financialYear, t.quarter, t.section, t.ratePct, t.rateReason, rupees(t.commissionBasePaise), rupees(t.ytdBeforePaise), rupees(t.thresholdPaise), rupees(t.tdsPaise), rupees(t.netPaise), t.depositDueDate && ymd(t.depositDueDate), t.depositedAt && ymd(t.depositedAt), t.challanNumber, t.bsrCode, t.returnQuarter, t.returnFiledAt && ymd(t.returnFiledAt), t.form16aIssuedAt && ymd(t.form16aIssuedAt), t.leadId]),
    );
  }
  if (kind === 'gst') {
    const rows = await prisma.moneyLedgerEntry.findMany({
      where: { entryDate: dateWhere, OR: [{ gstPaise: { gt: 0 } }, { type: { in: ['GST_INPUT', 'GST_INPUT_PENDING', 'GST_OUTPUT'] } }] },
      orderBy: { entryDate: 'asc' },
    });
    const outputTypes = ['BROKERAGE_INVOICED', 'PROCESSING_FEE_IN', 'CANCELLATION_CHARGE', 'SERVICE_REVENUE'];
    return csv(
      ['Date', 'Entry id', 'Type', 'Side', 'Deal id', 'Party', 'Taxable value', 'GST', 'Invoice no', 'Status', 'Note'],
      rows.map((r) => [ymd(r.entryDate), r.id, r.type, outputTypes.includes(r.type) ? 'OUTPUT' : 'INPUT', r.leadId, r.partyName || r.partyId, rupees(r.grossPaise - (r.type === 'GST_INPUT' || r.type === 'GST_INPUT_PENDING' ? r.gstPaise : 0)), rupees(r.gstPaise), r.invoiceNumber, r.status, r.note]),
    );
  }
  if (kind === 'payables') {
    const p = await payablesReceivables(to);
    const items = [
      ['Payable', 'Partner commission (net of TDS)', p.payables.partnerCommissionCount, p.payables.partnerCommissionPaise],
      ['Payable', 'Seller payouts', p.payables.sellerPayoutsCount, p.payables.sellerPayoutsPaise],
      ['Payable', 'Partner GST awaiting tax invoice match', '', p.payables.partnerGstAwaitingInvoicePaise],
      ['Payable', 'Partner GST payable after match', '', p.payables.partnerGstPayableAfterMatchPaise],
      ['Payable', 'TDS to deposit', p.payables.tdsToDepositCount, p.payables.tdsToDepositPaise],
      ['Payable', 'TDS overdue', p.payables.tdsOverdueCount, p.payables.tdsOverduePaise],
      ['Receivable', 'Brokerage outstanding', p.receivables.brokerageOutstandingDeals.length, p.receivables.brokerageOutstandingPaise],
      ['Receivable', 'TDS deducted by payers (claim back)', '', p.receivables.tdsReceivablePaise],
      ['Held for others', 'Tokens in escrow', p.heldForOthers.count, p.heldForOthers.tokensInEscrowPaise],
    ];
    return csv(['Side', 'Item', 'Count', 'Amount'], items.map((i) => [i[0], i[1], i[2], rupees(i[3])]));
  }
  if (kind === 'audit') {
    const rows = await prisma.auditLog.findMany({ where: { createdAt: dateWhere }, orderBy: { createdAt: 'asc' } });
    return csv(
      ['Time', 'Id', 'Actor id', 'Actor role', 'Action', 'Target type', 'Target id', 'Reason', 'Before', 'After', 'IP', 'Hash'],
      rows.map((r) => [new Date(r.createdAt).toISOString(), r.id, r.adminId, r.actorRole, r.action, r.targetType, r.targetId, r.reason, r.before, r.after, r.ipAddress, r.hash]),
    );
  }
  throw new ApiError(400, 'kind must be ledger, tds, gst, payables or audit');
}

module.exports = {
  LEDGER_TYPES, MANUAL_TYPES, record, recordSafe, addManual,
  onPaymentCaptured, onRefund, onSellerPayout, onPartnerCredit, onPayoutStatus,
  onBrokerageInvoiced, onBrokerageReceived, onTdsDeposited, onInvoiceMatched,
  listEntries, withCurrentStatus, dealMoneyCard, payablesReceivables, reconcile,
  profitView, monthlyCsv, csvCell, monthRange, buildWhere,
};
