const { z } = require('zod');

const createReferralSchema = z.object({
  buyerName: z.string().min(2).max(100),
  buyerPhone: z.string().min(5).max(20),
  buyerEmail: z.string().email().optional(),
  note: z.string().max(500).optional(),
});

const revokeReferralSchema = z.object({
  reason: z.string().min(5).max(500),
});

const listReferralsSchema = z.object({
  advisorId: z.string().optional(),
  buyerPhone: z.string().optional(),
  status: z.enum(['ACTIVE', 'REVOKED']).optional(),
});

module.exports = { createReferralSchema, revokeReferralSchema, listReferralsSchema };
