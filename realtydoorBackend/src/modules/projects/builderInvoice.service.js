const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const { getConfigNumber } = require('../config/config.service');
const { buildCommissionReceiptPdf } = require('../../lib/pdfReceipt');
const { s3Upload } = require('../../lib/fileUpload');

const DEFAULT_BUILDER_BROKERAGE_PCT_KEY = 'default_builder_brokerage_pct';
const DEFAULT_BUILDER_BROKERAGE_PCT = 2;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// R28 — admin confirms a unit sold and issues the brokerage invoice in one
// step; there's no negotiation phase like Lead commission has (the rate is
// already known — Project.brokeragePct or the platform default), so this
// goes straight to INVOICED rather than sitting at an unused PENDING.
async function createInvoice(unitId, adminId, ip) {
  const unit = await prisma.projectUnit.findUnique({
    where: { id: unitId },
    include: { project: { select: { id: true, title: true, brokeragePct: true, builderId: true, builder: { select: { name: true, companyName: true } } } } },
  });
  if (!unit) throw new ApiError(404, 'Unit not found');
  if (unit.status !== 'SOLD') {
    throw new ApiError(400, `Cannot invoice a unit that is ${unit.status} — mark it SOLD first`, { code: 'UNIT_NOT_SOLD' });
  }
  if (!unit.price) {
    throw new ApiError(400, 'This unit has no price set — set one before invoicing', { code: 'UNIT_PRICE_MISSING' });
  }

  const existing = await prisma.builderInvoice.findUnique({ where: { unitId } });
  if (existing) throw new ApiError(409, 'This unit already has an invoice', { code: 'INVOICE_ALREADY_EXISTS' });

  const brokeragePct = unit.project.brokeragePct
    ?? await getConfigNumber(DEFAULT_BUILDER_BROKERAGE_PCT_KEY, DEFAULT_BUILDER_BROKERAGE_PCT);
  const amount = round2((unit.price * brokeragePct) / 100);

  const invoicedAt = new Date();
  const pdfBuffer = await buildCommissionReceiptPdf({
    refCode: unit.unitNumber,
    propertyTitle: `${unit.project.title} — Unit ${unit.unitNumber}`,
    payerName: unit.project.builder?.companyName || unit.project.builder?.name,
    feePct: brokeragePct,
    dealPrice: unit.price,
    feeAmount: amount,
    invoicedAt,
    collectedAt: null,
  });
  const { url } = await s3Upload(pdfBuffer, 'receipts', `builder-invoice-${unitId}.pdf`, 'application/pdf');

  const invoice = await prisma.builderInvoice.create({
    data: {
      projectId: unit.projectId, unitId, builderId: unit.project.builderId,
      unitPrice: unit.price, brokeragePct, amount,
      status: 'INVOICED', invoiceUrl: url, invoicedAt,
      createdByAdminId: adminId,
    },
  });

  await createNotification({
    userId: unit.project.builderId,
    title: 'Brokerage invoice issued',
    message: `A brokerage invoice of ₹${amount.toLocaleString('en-IN')} for unit ${unit.unitNumber} (${unit.project.title}) is now due.`,
    type: 'BUILDER_INVOICE_ISSUED',
    linkUrl: url,
  });

  await createAuditLog({
    adminId, action: 'BUILDER_INVOICE_CREATED', targetType: 'ProjectUnit', targetId: unitId,
    after: { invoiceId: invoice.id, amount, brokeragePct }, ipAddress: ip,
  });

  return invoice;
}

async function collectInvoice(id, adminId, ip) {
  const invoice = await prisma.builderInvoice.findUnique({ where: { id } });
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  if (invoice.status !== 'INVOICED') {
    throw new ApiError(400, `Cannot collect from status ${invoice.status}`, { code: 'INVALID_INVOICE_STATUS' });
  }

  const collectedAt = new Date();
  const updated = await prisma.builderInvoice.update({ where: { id }, data: { status: 'COLLECTED', collectedAt } });

  await createNotification({
    userId: invoice.builderId,
    title: 'Brokerage payment confirmed',
    message: `Your brokerage payment of ₹${invoice.amount.toLocaleString('en-IN')} has been confirmed. Thank you.`,
    type: 'BUILDER_INVOICE_COLLECTED',
    linkUrl: '/partner/projects',
  });

  await createAuditLog({
    adminId, action: 'BUILDER_INVOICE_COLLECTED', targetType: 'BuilderInvoice', targetId: id,
    after: { collectedAt }, ipAddress: ip,
  });

  return updated;
}

// Same reasoning as commission.service.js's disputeLeadCommission — a
// COLLECTED invoice is already settled, and re-disputing an already-DISPUTED
// one should update the existing dispute, not silently replace it.
async function disputeInvoice(id, reason, adminId, ip) {
  const invoice = await prisma.builderInvoice.findUnique({ where: { id } });
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  if (invoice.status !== 'INVOICED') {
    throw new ApiError(400, `Cannot dispute from status ${invoice.status}`, { code: 'INVALID_INVOICE_STATUS' });
  }

  const updated = await prisma.builderInvoice.update({
    where: { id },
    data: { status: 'DISPUTED', disputeNote: reason },
  });

  await createAuditLog({
    adminId, action: 'BUILDER_INVOICE_DISPUTED', targetType: 'BuilderInvoice', targetId: id,
    before: { status: 'INVOICED' }, after: { status: 'DISPUTED', reason }, ipAddress: ip,
  });

  return updated;
}

async function listInvoicesAdmin(filters, skip, limit) {
  const where = {};
  if (filters.builderId) where.builderId = filters.builderId;
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.status) where.status = filters.status;
  const [data, total] = await Promise.all([
    prisma.builderInvoice.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, title: true } },
        unit: { select: { id: true, unitNumber: true } },
        builder: { select: { id: true, name: true, companyName: true } },
      },
    }),
    prisma.builderInvoice.count({ where }),
  ]);
  return { data, total };
}

async function listMyInvoices(builderId, filters, skip, limit) {
  const where = { builderId };
  if (filters.status) where.status = filters.status;
  const [data, total] = await Promise.all([
    prisma.builderInvoice.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, title: true } },
        unit: { select: { id: true, unitNumber: true } },
      },
    }),
    prisma.builderInvoice.count({ where }),
  ]);
  return { data, total };
}

module.exports = { createInvoice, collectInvoice, disputeInvoice, listInvoicesAdmin, listMyInvoices };
