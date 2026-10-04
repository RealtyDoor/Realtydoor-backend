const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const PAYEE_ROLES = ['PLATFORM', 'LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
const SELLER_TYPES = ['AGENT', 'BUILDER', 'ADVISOR', 'OWNER'];

// PLATFORM is never submitted — its share is computed by the service as
// whatever's left after the lines below (2026-10-04 decision). Rate card
// templates only take LISTING_AGENT/CLOSING_AGENT: ADVISOR is deal-specific
// and not knowable at template-design time (see commission.prisma).
const lineSchema = z.object({
  payeeRole: z.enum(['LISTING_AGENT', 'CLOSING_AGENT']),
  pct:       z.number().positive().max(100),
});

// A lead's lines additionally allow ADVISOR, who is normally paid a flat
// amount rather than a % (2026-10-04 decision). LISTING_AGENT/CLOSING_AGENT
// must give pct and never flatAmountPaise. ADVISOR must name payeeUserId (so
// the service knows whose standard rate to fall back to) and may give at
// most one of pct/flatAmountPaise — give neither to use that advisor's
// standard rate (User.advisorStandardFeePaise) outright.
const leadLineSchema = z.object({
  payeeRole:       z.enum(['LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR']),
  pct:             z.number().positive().max(100).optional(),
  flatAmountPaise: z.number().int().positive().optional(),
  payeeUserId:     objectId.optional(),
  reason:          z.string().max(500).optional(),
}).refine((l) => {
  if (l.payeeRole !== 'ADVISOR') return l.pct != null && l.flatAmountPaise == null;
  return l.payeeUserId != null && !(l.pct != null && l.flatAmountPaise != null);
}, {
  message: 'LISTING_AGENT/CLOSING_AGENT require pct only. ADVISOR requires payeeUserId, '
    + 'and at most one of pct/flatAmountPaise (give neither to use their standard rate).',
});

const createRateCardSchema = z.object({
  propertyId: objectId.optional(),
  projectId:  objectId.optional(),
  city:       z.string().min(2).max(100).optional(),
  sellerType: z.enum(SELLER_TYPES),
  feePct:     z.number().positive().max(100),
  // PLATFORM is the only value the enum allows today; accepted explicitly so
  // the API shape doesn't change when PARTNER is added.
  collectedBy: z.literal('PLATFORM').optional(),
  payer:       z.enum(['SELLER', 'BUYER']).optional(),
  terms:       z.string().max(2000).optional(),
  isActive:    z.boolean().optional(),
  lines:       z.array(lineSchema).min(1).max(10),
}).refine((d) => d.propertyId || d.city, {
  message: 'Provide a propertyId or a city for this card to apply to',
  path: ['city'],
});

const updateRateCardSchema = z.object({
  city:       z.string().min(2).max(100).optional(),
  sellerType: z.enum(SELLER_TYPES).optional(),
  feePct:     z.number().positive().max(100).optional(),
  payer:      z.enum(['SELLER', 'BUYER']).optional(),
  terms:      z.string().max(2000).optional(),
  isActive:   z.boolean().optional(),
  lines:      z.array(lineSchema).min(1).max(10).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

const createOverrideSchema = z.object({
  partnerId:       objectId,
  scope:           z.enum(['ALL', 'SELECTED']).default('ALL'),
  propertyIds:     z.array(objectId).max(200).optional(),
  // The partner's total share OF THE FEE. 0 is allowed — an override can
  // legitimately zero a partner's share.
  partnerSharePct: z.number().min(0).max(100),
  validUntil:      z.string().datetime().optional(),
  reason:          z.string().min(5).max(500),
});

// feePct is lead-level because the fee is negotiated per deal; the card only
// supplies a default. dealPrice lets admin record the agreed price when it
// differs from the listing price.
const setLeadTermsSchema = z.object({
  feePct:    z.number().positive().max(100).optional(),
  dealPrice: z.number().positive().optional(),
  lines:     z.array(leadLineSchema).min(1).max(10),
  note:      z.string().max(500).optional(),
});

module.exports = {
  createRateCardSchema, updateRateCardSchema, createOverrideSchema, setLeadTermsSchema,
  PAYEE_ROLES, SELLER_TYPES,
};
