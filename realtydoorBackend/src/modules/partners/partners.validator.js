const { z } = require('zod');

const updateProfileSchema = z.object({
  name:            z.string().min(2).max(100).optional(),
  companyName:     z.string().min(2).max(200).optional(),
  bio:             z.string().max(1000).optional(),
  websiteUrl:      z.string().url('Invalid URL').optional().or(z.literal('')),
  profileImageUrl: z.string().url('Invalid URL').optional(),
  partnerSubType:  z.string().max(50).optional(),
  // B1.6 / B1.8 / admin 3.2-3.3 — structured instead of "read it off the
  // uploaded KYC PDF". Deliberately NOT including panNumber: a partner
  // editing their own PAN after KYC verification would silently invalidate
  // what admin approved, so that one stays admin-set only.
  reraNumber:      z.string().max(60).optional(),
  gstin:           z.string().max(20).optional(),
  coverageAreas:   z.array(z.string().min(1).max(100)).max(50).optional(),
  address:         z.string().max(500).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
);

const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE    = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM

const updateSettingsSchema = z.object({
  visitDays:               z.array(z.enum(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])).optional(),
  visitFromTime:           z.string().regex(TIME_RE, 'Use HH:MM format').optional(),
  visitToTime:             z.string().regex(TIME_RE, 'Use HH:MM format').optional(),
  notifNewLead:            z.boolean().optional(),
  notifLeadExpiring:       z.boolean().optional(),
  notifEscrowReleased:     z.boolean().optional(),
  notifListingUpdate:      z.boolean().optional(),
  notifWeeklyReport:       z.boolean().optional(),
  leadAutoAccept:          z.boolean().optional(),
  leadPauseOverloaded:     z.boolean().optional(),
  leadPreferredLocalities: z.array(z.string().max(100)).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

const updateBankAccountSchema = z.object({
  bankName:               z.string().min(2).max(100),
  bankBranch:             z.string().min(2).max(100).optional(),
  bankAccountNo:          z.string().min(5).max(20),
  bankIfsc:               z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  bankHolderName:         z.string().min(2).max(100),
  razorpayRouteAccountId: z.string().min(5).max(50).optional(),
});

const createSupportTicketSchema = z.object({
  subject:     z.string().min(5).max(200),
  description: z.string().min(10).max(2000),
  category:    z.enum(['LEAD', 'ESCROW', 'LISTING', 'PAYMENT', 'GENERAL']).optional(),
});

// B12.3 — the agreement version the partner is accepting. Free-form string
// (e.g. "2026-10-v1") rather than an enum so a new version needs no deploy.
const acceptTermsSchema = z.object({
  version: z.string().min(1).max(40),
});

// B12.1 — RazorpayX payout account onboarding. IFSC and PAN are checked
// against their real formats here so a typo fails locally instead of as an
// opaque provider error. accountNumber length is per RBI's 9-18 digit range.
const createPayoutAccountSchema = z.object({
  legalName:     z.string().min(2).max(120),
  accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9-18 digits'),
  ifsc:          z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  panNumber:     z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  bankName:      z.string().max(120).optional(),
});

const PAYOUT_STATUSES = ['ACTIVE', 'PENDING_VALIDATION', 'NEEDS_CLARIFICATION', 'SUSPENDED'];

const setPayoutStatusSchema = z.object({
  status: z.enum(PAYOUT_STATUSES),
  note:   z.string().max(500).optional(),
}).refine((d) => d.status === 'ACTIVE' || !!d.note, {
  message: 'A note is required when the status is not ACTIVE',
  path: ['note'],
});

module.exports = {
  createPayoutAccountSchema,
  setPayoutStatusSchema,
  PAYOUT_STATUSES,
  acceptTermsSchema,
  updateProfileSchema,
  updateSettingsSchema,
  updateBankAccountSchema,
  createSupportTicketSchema,
};
