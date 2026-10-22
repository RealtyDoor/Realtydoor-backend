const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const money = z.number().finite().nonnegative();
const MANUAL_TYPES = ['ADJUSTMENT', 'GATEWAY_FEE', 'SETTLEMENT_IN', 'PAYOUT_FEE', 'VENDOR_PAYMENT', 'TDS_RECEIVABLE'];

const manualEntrySchema = z.object({
  type: z.enum(MANUAL_TYPES),
  direction: z.enum(['IN', 'OUT', 'NONE']),
  partyType: z.enum(['BUYER', 'SELLER', 'PARTNER', 'VENDOR', 'GOVERNMENT', 'RAZORPAY', 'REALTYDOOR']),
  partyName: z.string().max(200).optional(),
  leadId: objectId.optional(),
  escrowId: objectId.optional(),
  // Paise, integers.
  grossPaise: z.number().int(),
  gstPaise: z.number().int().optional(),
  tdsPaise: z.number().int().optional(),
  feePaise: z.number().int().optional(),
  netPaise: z.number().int().optional(),
  razorpaySettlementId: z.string().max(100).optional(),
  utr: z.string().max(100).optional(),
  invoiceNumber: z.string().max(100).optional(),
  reversesEntryId: objectId.optional(),
  entryDate: z.string().datetime().optional(),
  reason: z.string().min(5).max(500),
  note: z.string().max(500).optional(),
});

const ids = z.array(objectId).min(1).max(200);
const depositSchema = z.object({
  ids, challanNumber: z.string().min(3).max(50), bsrCode: z.string().min(3).max(20), depositedAt: z.string().datetime().optional(),
});
const returnSchema = z.object({ ids, returnQuarter: z.string().min(3).max(30), filedAt: z.string().datetime().optional() });
const form16aSchema = z.object({ ids, issuedAt: z.string().datetime().optional() });

const rejectInvoiceSchema = z.object({ reason: z.string().min(5).max(500) });
const matchInvoiceSchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM').optional() });

// Multipart body, so numbers arrive as strings.
const num = z.coerce.number().finite().nonnegative();
const uploadInvoiceSchema = z.object({
  leadId: objectId,
  supplierGstin: z.string().min(15).max(15),
  recipientGstin: z.string().length(15).optional(),
  invoiceNumber: z.string().min(1).max(50),
  invoiceDate: z.string().min(8),
  sacCode: z.string().min(2).max(10).optional(),
  placeOfSupply: z.string().min(2).max(100),
  taxableValue: num, cgst: num.optional(), sgst: num.optional(), igst: num.optional(), total: num,
});

const voucherAcceptSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'The code is 6 digits') });

module.exports = {
  manualEntrySchema, depositSchema, returnSchema, form16aSchema,
  rejectInvoiceSchema, matchInvoiceSchema, uploadInvoiceSchema, voucherAcceptSchema, money,
};
