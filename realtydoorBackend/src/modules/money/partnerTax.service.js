'use strict';

// Partner paperwork for a commission (money model Rev 3, phase 2):
//  - GST-registered partner: a tax invoice from their own business, uploaded
//    in the app. NO payout of any kind to the partner on that deal until an
//    admin has accepted it. The GST part stays GST_INPUT_PENDING until it is
//    matched in our GSTR-2B.
//  - Unregistered partner: a commission voucher accepted by OTP.
// Plus the per-deal partner statement. Every action writes an audit entry.

const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const money = require('../../lib/moneyModel');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { sendVoucherOtp } = require('../../lib/wati');
const otp = require('../../lib/otp');
const { getMoneySettings } = require('./moneyConfig');
const ledger = require('./ledger.service');

const VOUCHER_OTP_MINUTES = 10;
const VOUCHER_OTP_MAX_ATTEMPTS = 5;
const VOUCHER_OTP_RESEND_SECONDS = 60;

const hashCode = (code) => crypto.createHmac('sha256', process.env.OTP_HASH_SECRET || 'unset').update(code).digest('hex');

// ─── The commission this partner is owed on a deal ───────────────────────────

async function commissionFor(leadId, partnerId) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, refCode: true, assignedPartnerId: true, feePct: true, dealPriceAtLock: true,
      commissionLockedAt: true, commissionVersion: true, property: { select: { price: true, title: true } },
    },
  });
  if (!lead || lead.assignedPartnerId !== partnerId) throw new ApiError(404, 'Deal not found');
  if (!lead.commissionLockedAt) throw new ApiError(400, 'The commission terms for this deal are not locked yet', { code: 'COMMISSION_NOT_LOCKED' });
  const price = lead.dealPriceAtLock ?? lead.property?.price ?? null;
  const fee = price && lead.feePct ? Math.round(price * lead.feePct) / 100 : null;
  const lines = await prisma.leadCommissionLine.findMany({ where: { leadId, version: lead.commissionVersion } });
  return {
    lead,
    dealPrice: price,
    commissionPaise: money.partnerLinesCommissionPaise(lines, fee, partnerId),
  };
}

// The accepted invoice that releases the payout on a deal, if any.
async function getAcceptedInvoice(leadId, partnerId) {
  return prisma.partnerTaxInvoice.findFirst({
    where: { leadId, partnerId, status: { in: ['ACCEPTED', 'MATCHED'] } },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── Tax invoice (registered partner) ────────────────────────────────────────

async function uploadInvoice(partnerId, leadId, fields, fileUrl, ip) {
  if (!fileUrl) throw new ApiError(400, 'Attach the invoice file (PDF or image)', { code: 'FILE_REQUIRED' });
  const [{ commissionPaise, lead }, partner, settings] = await Promise.all([
    commissionFor(leadId, partnerId),
    prisma.user.findUnique({ where: { id: partnerId }, select: { gstin: true } }),
    getMoneySettings(),
  ]);

  const input = {
    supplierGstin: fields.supplierGstin, recipientGstin: fields.recipientGstin || settings.company.gstin,
    invoiceNumber: fields.invoiceNumber, invoiceDate: fields.invoiceDate, sacCode: fields.sacCode || settings.company.sacCode,
    placeOfSupply: fields.placeOfSupply,
    taxableValuePaise: money.toPaise(fields.taxableValue), cgstPaise: money.toPaise(fields.cgst || 0),
    sgstPaise: money.toPaise(fields.sgst || 0), igstPaise: money.toPaise(fields.igst || 0), totalPaise: money.toPaise(fields.total),
  };
  const problems = money.validateTaxInvoice(input, { commissionPaise, partnerGstin: partner?.gstin, settings });
  if (problems.length) {
    throw new ApiError(400, problems[0].message, { code: 'INVOICE_INVALID', problems });
  }

  // A deal already settled by commission voucher (the partner had no GSTIN then) carried no GST, so a tax invoice now would
  // book input credit for GST that was never paid.
  const voucher = await prisma.commissionVoucher.findFirst({ where: { leadId, partnerId } });
  if (voucher) throw new ApiError(409, `This deal was already paid by commission voucher ${voucher.voucherNumber}, so it cannot take a tax invoice.`, { code: 'DEAL_PAID_BY_VOUCHER' });

  // One live invoice per deal: a new upload is only for a deal with none, or
  // after the last one was rejected.
  const live = await prisma.partnerTaxInvoice.findFirst({ where: { leadId, partnerId, status: { in: ['UPLOADED', 'ACCEPTED', 'MATCHED'] } } });
  if (live) throw new ApiError(409, `This deal already has an invoice (${live.invoiceNumber}, ${live.status.toLowerCase()}).`, { code: 'INVOICE_EXISTS' });

  const supplierGstin = money.normGstin(input.supplierGstin);
  let created;
  try {
    created = await prisma.partnerTaxInvoice.create({
      data: {
        partnerId, leadId, status: 'UPLOADED', fileUrl, supplierGstin,
        invoiceNumber: String(input.invoiceNumber).trim(), invoiceDate: new Date(input.invoiceDate),
        recipientGstin: String(input.recipientGstin).trim().toUpperCase(), sacCode: String(input.sacCode).trim(),
        placeOfSupply: String(input.placeOfSupply).trim(),
        taxableValuePaise: input.taxableValuePaise, cgstPaise: input.cgstPaise, sgstPaise: input.sgstPaise,
        igstPaise: input.igstPaise, totalPaise: input.totalPaise,
      },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'You already used this invoice number', { code: 'INVOICE_NUMBER_USED' });
    throw err;
  }

  await createAuditLog({
    adminId: partnerId, actorRole: 'PARTNER', action: 'TAX_INVOICE_UPLOADED', targetType: 'PartnerTaxInvoice', targetId: created.id,
    after: { leadId, invoiceNumber: created.invoiceNumber, taxableValuePaise: created.taxableValuePaise, totalPaise: created.totalPaise, fileUrl }, ipAddress: ip,
  });
  const { notifyAdmins } = require('../../lib/notifications');
  notifyAdmins?.({ title: 'Partner tax invoice uploaded', message: `Invoice ${created.invoiceNumber} for deal ${lead.refCode || leadId} is waiting for review.`, type: 'TAX_INVOICE_UPLOADED', linkUrl: '/admin/money/tax-invoices' })
    ?.catch?.((e) => logger.warn('[TaxInvoice] admin notify failed', { error: e.message }));
  return created;
}

async function reviewInvoice(id, decision, { reason }, adminId, ip) {
  const inv = await prisma.partnerTaxInvoice.findUnique({ where: { id } });
  if (!inv) throw new ApiError(404, 'Invoice not found');
  if (inv.status !== 'UPLOADED') throw new ApiError(409, `Only an uploaded invoice can be reviewed (this one is ${inv.status})`, { code: 'INVOICE_NOT_PENDING' });
  if (decision === 'REJECTED' && !reason?.trim()) throw new ApiError(400, 'A reason is required to reject an invoice', { code: 'REASON_REQUIRED' });

  const claim = await prisma.partnerTaxInvoice.updateMany({
    where: { id, status: 'UPLOADED' },
    data: { status: decision, reviewedByAdminId: adminId, reviewedAt: new Date(), rejectionReason: decision === 'REJECTED' ? reason.trim() : null },
  });
  if (claim.count === 0) throw new ApiError(409, 'Someone else just reviewed this invoice');

  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: decision === 'ACCEPTED' ? 'TAX_INVOICE_ACCEPTED' : 'TAX_INVOICE_REJECTED',
    targetType: 'PartnerTaxInvoice', targetId: id, before: { status: 'UPLOADED' }, after: { status: decision, invoiceNumber: inv.invoiceNumber },
    reason: reason?.trim() || null, ipAddress: ip,
  });
  await createNotification({
    userId: inv.partnerId,
    title: decision === 'ACCEPTED' ? 'Tax invoice accepted' : 'Tax invoice rejected',
    message: decision === 'ACCEPTED'
      ? `Invoice ${inv.invoiceNumber} was accepted. Your commission payout can now go ahead.`
      : `Invoice ${inv.invoiceNumber} was rejected: ${reason.trim()}. Please upload a corrected invoice.`,
    type: decision === 'ACCEPTED' ? 'TAX_INVOICE_ACCEPTED' : 'TAX_INVOICE_REJECTED', linkUrl: '/partners/finance',
  }).catch((e) => logger.warn('[TaxInvoice] partner notify failed', { error: e.message }));
  (async () => {
    const partner = await prisma.user.findUnique({ where: { id: inv.partnerId }, select: { email: true } });
    const accepted = decision === 'ACCEPTED';
    require('../../lib/wati').notifyUser(inv.partnerId, accepted ? 'partner_tax_invoice_accepted' : 'partner_tax_invoice_rejected', {
      partner_name: '$userName', invoice_number: inv.invoiceNumber, ...(accepted ? {} : { reason: reason.trim() }),
    }, { leadId: inv.leadId });
    if (partner?.email) await require('../../lib/email').sendTaxInvoiceReviewed(partner.email, { accepted, invoiceNumber: inv.invoiceNumber, reason: reason?.trim() });
  })().catch((e) => logger.warn('[TaxInvoice] partner message failed', { error: e.message }));
  return prisma.partnerTaxInvoice.findUnique({ where: { id } });
}

// The partner's invoice shows in our GSTR-2B: input credit can be claimed and
// the GST part of the commission becomes payable.
async function markInvoiceMatched(id, { period }, adminId, ip) {
  const inv = await prisma.partnerTaxInvoice.findUnique({ where: { id } });
  if (!inv) throw new ApiError(404, 'Invoice not found');
  if (inv.status !== 'ACCEPTED') throw new ApiError(409, `Only an accepted invoice can be matched (this one is ${inv.status})`, { code: 'INVOICE_NOT_ACCEPTED' });
  const claim = await prisma.partnerTaxInvoice.updateMany({
    where: { id, status: 'ACCEPTED' },
    data: { status: 'MATCHED', matchedAt: new Date(), matchedByAdminId: adminId, gstr2bPeriod: period || null },
  });
  if (claim.count === 0) throw new ApiError(409, 'This invoice was just updated');
  const updated = await prisma.partnerTaxInvoice.findUnique({ where: { id } });
  await ledger.onInvoiceMatched(updated, { adminId });
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'TAX_INVOICE_MATCHED', targetType: 'PartnerTaxInvoice', targetId: id,
    before: { status: 'ACCEPTED' }, after: { status: 'MATCHED', gstr2bPeriod: period || null }, ipAddress: ip,
  });
  return updated;
}

async function listInvoicesForPartner(partnerId) {
  return prisma.partnerTaxInvoice.findMany({ where: { partnerId }, orderBy: { createdAt: 'desc' } });
}

async function listInvoicesAdmin(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.partnerId) where.partnerId = filters.partnerId;
  if (filters.leadId) where.leadId = filters.leadId;
  const [data, total] = await Promise.all([
    prisma.partnerTaxInvoice.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.partnerTaxInvoice.count({ where }),
  ]);
  return { data, total };
}

// ─── Commission voucher (unregistered partner) ───────────────────────────────

async function nextVoucherNumber(now = new Date()) {
  const { financialYear } = money.financialYearOf(now);
  const counter = await prisma.counter.upsert({
    where: { id: `voucher-${financialYear}` }, update: { seq: { increment: 1 } }, create: { id: `voucher-${financialYear}`, seq: 1 },
  });
  return `CV/${financialYear}/${String(counter.seq).padStart(6, '0')}`;
}

// Created when the commission is credited. One per deal (unique on escrowId).
async function createVoucher(escrow, c, { tdsRatePct, tdsSection, payoutId, utr }) {
  const existing = await prisma.commissionVoucher.findUnique({ where: { escrowId: escrow.id } });
  if (existing) return existing;
  const [partner, lead, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: c.partnerId }, select: { name: true, panNumber: true, billingAddress: true, address: true } }),
    prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, dealPriceAtLock: true, partnerRatePct: true, property: { select: { title: true, price: true } } } }),
    getMoneySettings(),
  ]);
  void settings;
  const price = lead?.dealPriceAtLock ?? lead?.property?.price ?? 0;
  return prisma.commissionVoucher.create({
    data: {
      voucherNumber: await nextVoucherNumber(), partnerId: c.partnerId, leadId: escrow.leadId, escrowId: escrow.id,
      partnerName: partner?.name || 'Partner', partnerAddress: partner?.billingAddress || partner?.address || null,
      partnerPan: partner?.panNumber ? partner.panNumber.trim().toUpperCase() : null,
      dealRef: lead?.refCode || null, propertyTitle: lead?.property?.title || null,
      dealPricePaise: money.toPaise(price), ratePct: lead?.partnerRatePct ?? 0,
      commissionPaise: c.commissionPaise, tdsPaise: c.tdsPaise, tdsRatePct: tdsRatePct ?? 0, tdsSection: tdsSection || '',
      netPaise: c.commissionPaise - c.tdsPaise, payoutId: payoutId || null, utr: utr || null,
    },
  });
}

async function requestVoucherOtp(partnerId, voucherId, ip) {
  const v = await prisma.commissionVoucher.findFirst({ where: { id: voucherId, partnerId } });
  if (!v) throw new ApiError(404, 'Voucher not found');
  if (v.status === 'ACCEPTED') throw new ApiError(409, 'This voucher is already accepted', { code: 'VOUCHER_ACCEPTED' });
  if (v.otpSentAt && Date.now() - new Date(v.otpSentAt).getTime() < VOUCHER_OTP_RESEND_SECONDS * 1000) {
    throw new ApiError(429, `Wait ${VOUCHER_OTP_RESEND_SECONDS} seconds before asking for another code`, { code: 'OTP_TOO_SOON' });
  }
  const partner = await prisma.user.findUnique({ where: { id: partnerId }, select: { phone: true, phoneVerified: true } });
  if (!partner?.phone || partner.phoneVerified !== true) {
    throw new ApiError(400, 'Verify your phone number first; the code is sent to it', { code: 'PHONE_NOT_VERIFIED' });
  }
  const code = otp.generate();
  await prisma.commissionVoucher.update({
    where: { id: v.id },
    data: { otpHash: hashCode(code), otpExpiresAt: new Date(Date.now() + VOUCHER_OTP_MINUTES * 60e3), otpAttempts: 0, otpSentAt: new Date() },
  });
  let delivered = null;
  try {
    delivered = await sendVoucherOtp(partner.phone, code, v.voucherNumber, { userId: partnerId });
  } catch (err) {
    logger.error(`[voucher] OTP send failed for voucher ${v.id}: ${err.message}`);
  }
  if (!delivered) {
    // Nothing reached the partner: drop the code and the resend lock so they can try again at once.
    await prisma.commissionVoucher.update({ where: { id: v.id }, data: { otpHash: null, otpExpiresAt: null, otpAttempts: 0, otpSentAt: null } });
    throw new ApiError(503, 'We could not send the code to your WhatsApp. Please try again in a few minutes, or ask Realtydoor support.', { code: 'OTP_SEND_FAILED' });
  }
  await createAuditLog({
    adminId: partnerId, actorRole: 'PARTNER', action: 'COMMISSION_VOUCHER_OTP_SENT', targetType: 'CommissionVoucher', targetId: v.id,
    after: { voucherNumber: v.voucherNumber }, ipAddress: ip,
  });
  return { sent: true, expiresInMinutes: VOUCHER_OTP_MINUTES };
}

async function acceptVoucher(partnerId, voucherId, code, ip) {
  const v = await prisma.commissionVoucher.findFirst({ where: { id: voucherId, partnerId } });
  if (!v) throw new ApiError(404, 'Voucher not found');
  if (v.status === 'ACCEPTED') return v;
  if (!v.otpHash || otp.isExpired(v.otpExpiresAt)) throw new ApiError(400, 'The code expired. Ask for a new one.', { code: 'OTP_EXPIRED' });
  if (v.otpAttempts >= VOUCHER_OTP_MAX_ATTEMPTS) throw new ApiError(429, 'Too many wrong codes. Ask for a new one.', { code: 'OTP_LOCKED' });
  const a = Buffer.from(hashCode(String(code || '')), 'hex');
  const b = Buffer.from(v.otpHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await prisma.commissionVoucher.update({ where: { id: v.id }, data: { otpAttempts: { increment: 1 } } });
    throw new ApiError(400, 'That code is not right', { code: 'OTP_WRONG' });
  }
  const claim = await prisma.commissionVoucher.updateMany({
    where: { id: v.id, status: 'ISSUED' },
    data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedIp: ip || null, otpHash: null },
  });
  if (claim.count === 0) return prisma.commissionVoucher.findUnique({ where: { id: v.id } });
  await createAuditLog({
    adminId: partnerId, actorRole: 'PARTNER', action: 'COMMISSION_VOUCHER_ACCEPTED', targetType: 'CommissionVoucher', targetId: v.id,
    before: { status: 'ISSUED' }, after: { status: 'ACCEPTED', voucherNumber: v.voucherNumber, netPaise: v.netPaise }, ipAddress: ip,
  });
  return prisma.commissionVoucher.findUnique({ where: { id: v.id } });
}

const publicVoucher = ({ otpHash, otpAttempts, otpExpiresAt, otpSentAt, ...rest }) => rest;

async function listVouchersForPartner(partnerId) {
  const rows = await prisma.commissionVoucher.findMany({ where: { partnerId }, orderBy: { createdAt: 'desc' } });
  return rows.map(publicVoucher);
}

// ─── Statement for one deal (what the partner sees) ──────────────────────────

async function buildStatement(partnerId, escrowId) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Statement not found');
  const lead = await prisma.lead.findUnique({
    where: { id: escrow.leadId },
    select: { id: true, refCode: true, assignedPartnerId: true, dealPriceAtLock: true, partnerRatePct: true, commissionRateCustom: true, property: { select: { title: true, price: true } } },
  });
  if (!lead || lead.assignedPartnerId !== partnerId) throw new ApiError(404, 'Statement not found');
  const [tds, voucher, invoice, partner, settings] = await Promise.all([
    prisma.tdsEntry.findUnique({ where: { escrowId } }),
    prisma.commissionVoucher.findUnique({ where: { escrowId } }),
    prisma.partnerTaxInvoice.findFirst({ where: { leadId: lead.id, partnerId, status: { not: 'REJECTED' } }, orderBy: { createdAt: 'desc' } }),
    prisma.user.findUnique({ where: { id: partnerId }, select: { gstin: true, name: true, panNumber: true } }),
    getMoneySettings(),
  ]);
  const registered = !!partner?.gstin?.trim();
  const commissionPaise = escrow.partnerGrossPaise ?? tds?.commissionBasePaise ?? null;
  const gstPaise = registered && commissionPaise != null ? money.pctOf(commissionPaise, settings.commission.gstPct) : 0;
  const netPaise = escrow.partnerSharePaise ?? tds?.netPaise ?? null;
  const awaiting = escrow.partnerPayoutStatus === 'deferred';
  let state = 'NOT_RELEASED';
  if (escrow.status === 'RELEASED') {
    if (awaiting) state = registered && !(invoice && ['ACCEPTED', 'MATCHED'].includes(invoice.status)) ? 'AWAITING_TAX_INVOICE' : 'AWAITING_PAYOUT';
    else state = escrow.partnerPayoutStatus === 'processed' ? 'PAID' : 'PAYOUT_IN_PROGRESS';
  }
  return {
    escrowId, dealRef: lead.refCode, propertyTitle: lead.property?.title ?? null,
    dealPricePaise: money.toPaise(lead.dealPriceAtLock ?? lead.property?.price ?? 0),
    ratePct: lead.partnerRatePct ?? null, isCustomRate: !!lead.commissionRateCustom,
    state,
    commissionPaise, gstRegistered: registered, gstPaise, gstStatus: registered ? (invoice?.status === 'MATCHED' ? 'PAYABLE' : 'PENDING_INVOICE_MATCH') : null,
    tds: tds ? { paise: tds.tdsPaise, ratePct: tds.ratePct, section: tds.section, reason: tds.rateReason, ytdBeforePaise: tds.ytdBeforePaise } : null,
    netPaise, bankReference: escrow.partnerPayoutUtr ?? null, payoutStatus: escrow.partnerPayoutStatus ?? null,
    date: escrow.releasedAt,
    document: registered
      ? { type: 'TAX_INVOICE', status: invoice?.status ?? 'NOT_UPLOADED', id: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null }
      : { type: 'COMMISSION_VOUCHER', status: voucher?.status ?? null, id: voucher?.id ?? null, voucherNumber: voucher?.voucherNumber ?? null },
    partner: { name: partner?.name ?? null },
    legalName: settings.company.legalName,
  };
}

async function listStatements(partnerId) {
  const escrows = await prisma.escrowTransaction.findMany({
    where: { lead: { assignedPartnerId: partnerId }, status: 'RELEASED' }, orderBy: { releasedAt: 'desc' }, select: { id: true },
  });
  return Promise.all(escrows.map((e) => buildStatement(partnerId, e.id)));
}

module.exports = {
  commissionFor, getAcceptedInvoice,
  uploadInvoice, reviewInvoice, markInvoiceMatched, listInvoicesForPartner, listInvoicesAdmin,
  createVoucher, requestVoucherOtp, acceptVoucher, listVouchersForPartner, publicVoucher,
  buildStatement, listStatements, nextVoucherNumber,
};
