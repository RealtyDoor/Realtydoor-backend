const { z } = require('zod');
const { phoneField, normalizePhone } = require('../../lib/phoneUtils');

const createReferralSchema = z.object({
  buyerName: z.string().min(2).max(100),
  // Audit Nov 2026 (P11). Stored in the same form as Lead.buyerPhone (E.164), or the commission lookup never matches.
  buyerPhone: phoneField,
  buyerEmail: z.string().email().optional(),
  note: z.string().max(500).optional(),
});

const revokeReferralSchema = z.object({
  reason: z.string().min(5).max(500),
});

const listReferralsSchema = z.object({
  advisorId: z.string().optional(),
  buyerPhone: z.string().optional().transform((v) => (v ? normalizePhone(v) || v : v)),
  status: z.enum(['ACTIVE', 'REVOKED']).optional(),
});

module.exports = { createReferralSchema, revokeReferralSchema, listReferralsSchema };
