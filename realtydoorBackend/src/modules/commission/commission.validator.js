const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const PAYEE_ROLES = ['PLATFORM', 'LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
const SELLER_TYPES = ['AGENT', 'BUILDER', 'ADVISOR', 'OWNER'];

// The sum-to-100 rule lives in the service, not here: it applies identically
// to card lines and lead lines, and the service is the only place that can
// also apply it to lines produced by pre-fill or an override rescale.
const lineSchema = z.object({
  payeeRole: z.enum(PAYEE_ROLES),
  pct:       z.number().positive().max(100),
});

const leadLineSchema = lineSchema.extend({
  payeeUserId: objectId.optional(),
  reason:      z.string().max(500).optional(),
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
