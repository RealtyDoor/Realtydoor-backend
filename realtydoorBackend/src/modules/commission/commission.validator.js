const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const PAYEE_ROLES = ['LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
const SELLER_TYPES = ['AGENT', 'BUILDER', 'ADVISOR', 'OWNER'];

// backend-gaps-frontend-integration.md #1 (2026-10-05) — PLATFORM is not a
// commission line at all any more; its share (R) is computed from real
// gateway costs, independent of what's submitted here. Rate card templates
// only take LISTING_AGENT/CLOSING_AGENT: ADVISOR is deal-specific and not
// knowable at template-design time (see commission.prisma).
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

// Money model Rev 3 — a negotiated per-project partner rate (% of the deal
// price). platformFeePct defaults to the platform setting. A rate that differs
// from the default needs a reason (checked in the service, which knows the
// default).
const projectRateSchema = z.object({
  partnerRatePct: z.number().min(0).max(20),
  platformFeePct: z.number().min(0).max(20).optional(),
  reason:         z.string().max(500).optional(),
  sellerType:     z.enum(SELLER_TYPES).optional(),
});

// Money model Rev 3 — the rate on one deal. The reason is required (checked in the service, which knows the default)
// whenever the rate differs from the platform default.
const dealRateSchema = z.object({
  partnerRatePct: z.number().gt(0).max(20),
  platformFeePct: z.number().min(0).max(20).optional(),
  reason:         z.string().max(500).optional(),
});

// R26
const disputeCommissionSchema = z.object({
  reason: z.string().min(5).max(500),
});

// Collecting a seller's success fee: the TDS the seller held back is a plain non-negative rupee amount (a negative one would
// inflate what we record as received).
const collectCommissionSchema = z.object({
  tdsDeductedRupees: z.coerce.number().finite().min(0, 'TDS cannot be negative').max(1_000_000_000).optional().default(0),
}).default({});

module.exports = {
  collectCommissionSchema,
  createRateCardSchema, updateRateCardSchema, createOverrideSchema, setLeadTermsSchema, dealRateSchema,
  disputeCommissionSchema, projectRateSchema,
  PAYEE_ROLES, SELLER_TYPES,
};
