const { z } = require('zod');
const { objectId } = require('../../utils/validators');
const { phoneField } = require('../../lib/phoneUtils');

const requestPhoneOtpSchema = z.object({
  phone: phoneField,
});

// phone is required here too — verification must be checked against the
// number the caller is proving they own, not whatever is on the user row.
const verifyPhoneOtpSchema = z.object({
  phone: phoneField,
  otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

const toggleFavoriteSchema = z.object({
  propertyId: objectId,
});

const DOCUMENT_TYPES = [
  'PAN_CARD', 'AADHAR', 'SALARY_SLIP', 'FORM_16', 'BANK_STATEMENT',
  'PASSPORT', 'OCI_PIO_CARD', 'POA_DRAFT', 'POA_NOTARIZED', 'NRE_NRO_PROOF',
];

const uploadDocumentSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES, {
    errorMap: () => ({ message: `documentType must be one of: ${DOCUMENT_TYPES.join(', ')}` }),
  }),
});

const raiseTicketSchema = z.object({
  subscriptionId: objectId,
  subject: z.string().min(3, 'Subject must be at least 3 characters').max(200),
  description: z.string().min(5, 'Description must be at least 5 characters').max(2000),
  category: z.enum(['PLUMBING', 'ELECTRICAL', 'PAINTING', 'GENERAL']).optional(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
  propertyId: objectId.optional(),
  // 7.8 — the deal this post-purchase ticket traces back to, when the user
  // knows it (e.g. raised right after a specific closed deal). Admin can
  // also set/correct this later via PATCH .../tickets/:id/link-deal.
  leadId: objectId.optional(),
  photos: z.array(z.string().url()).max(10).optional(),
});

const reopenTicketSchema = z.object({
  reason: z.string().min(3, 'Reason must be at least 3 characters').max(1000),
});

const verifyTicketSchema = z.object({
  vendorRating: z.number().int().min(1).max(5).optional(),
  vendorRatingComment: z.string().max(1000).optional(),
});

const ticketCommentSchema = z.object({
  text: z.string().min(1).max(2000),
  photos: z.array(z.string().url()).max(10).optional(),
});

// Dev feedback, 2026-10-08 — tenureMonths and submittedDocIds already exist
// on the model but were never accepted here, so the form's tenure slider
// and document-sharing step had nowhere to land. Field names/requiredness
// here match the frontend's actual ShareConsentScreen payload exactly
// (documentSharingConsent, required on every submission — the frontend
// only allows submitting after the checkbox is ticked, so this mirrors
// that, not a looser "only when documents are attached" rule).
// documentSharingConsentVersion is optional — the frontend doesn't send
// one yet, but it's accepted and stored the moment it does, same
// two-field shape as partners.validator.js's acceptTermsSchema.version.
// tenureMonths here is the REQUEST field name only — createLoanApplication
// stores it as tenureMonthsRequested, since admin sets a (possibly
// different) sanctioned tenureMonths later via updateLoanStatusSchema and
// the two must not collide.
const createLoanSchema = z.object({
  propertyId: objectId.optional(),
  preferredBank: z.string().max(100).optional(),
  loanAmountRequestedPaise: z.number().int().positive().optional(),
  tenureMonths: z.number().int().positive().max(480).optional(),
  submittedDocIds: z.array(objectId).max(20).optional(),
  documentSharingConsent: z.literal(true, { errorMap: () => ({ message: 'Document-sharing consent is required to submit a loan application' }) }),
  documentSharingConsentVersion: z.string().min(1).max(40).optional(),
});

const notificationPreferencesSchema = z.object({
  push:           z.boolean().optional(),
  email:          z.boolean().optional(),
  whatsapp:       z.boolean().optional(),
  marketing:      z.boolean().optional(),
  visitReminders: z.boolean().optional(),
});

const updateProfileSchema = z.object({
  name:    z.string().min(2).max(100).optional(),
  isNRI:   z.boolean().optional(),
  address: z.string().max(500).optional(),
  language: z.enum(['en', 'kn', 'hi']).optional(),
  notificationPreferences: notificationPreferencesSchema.optional(),
  buyerType: z.enum(['BUYER', 'RENTER', 'INVESTOR']).optional(),
  city:      z.string().max(100).optional(),
  budget:    z.string().max(100).optional(),
  bhk:       z.array(z.string()).optional(),
  timeline:  z.enum(['NOW', '3_6_MONTHS', 'BROWSING']).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

const requestVideoTourSchema = z.object({
  propertyId: objectId,
  userNote:   z.string().max(500).optional(),
});

const raiseDisputeSchema = z.object({
  type:        z.enum(['LEAD', 'ESCROW', 'SERVICE'], {
    errorMap: () => ({ message: 'type must be LEAD, ESCROW, or SERVICE' }),
  }),
  referenceId: objectId,
  reason:      z.string().min(5).max(200),
  description: z.string().min(10).max(2000),
});

const rateLeadSchema = z.object({
  rating:  z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const cancelLeadSchema = z.object({
  reason:      z.string().min(3).max(1000),
  reasonLabel: z.string().min(2).max(200),
});

const updateConsentSchema = z.object({
  termsAccepted:   z.boolean().optional(),
  privacyAccepted: z.boolean().optional(),
  marketingOptIn:  z.boolean().optional(),
  // Backend gaps handoff, 2026-10-10 (#4) — which published version of the
  // terms/privacy doc this acceptance is for, compared against config keys
  // terms_version/privacy_version to compute requiresReconsent later.
  documentVersion: z.string().min(1).max(40).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

// Backend gaps handoff, 2026-10-10 (#1) — the new canonical POST
// /user/consent/withdraw body. The legacy alias (POST /user/privacy/
// withdraw-consent) sends no body at all and isn't validated against this
// — see users.controller.js.
const withdrawConsentSchema = z.object({
  scope: z.enum(['MARKETING', 'ALL'], {
    errorMap: () => ({ message: 'scope must be MARKETING or ALL' }),
  }),
});

// Backend gaps handoff, 2026-10-10 (#1) — the new canonical POST
// /user/account/deletion-request body. confirm must be the literal true,
// not merely truthy — same explicit-intent pattern as createLoanSchema's
// documentSharingConsent. The legacy alias (POST /user/privacy/
// delete-account) sends no body and isn't validated against this.
const requestDeletionSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: 'confirm must be true to request account deletion' }) }),
  reason: z.string().max(1000).optional(),
});

module.exports = {
  requestPhoneOtpSchema,
  verifyPhoneOtpSchema,
  toggleFavoriteSchema,
  uploadDocumentSchema,
  raiseTicketSchema,
  createLoanSchema,
  updateProfileSchema,
  requestVideoTourSchema,
  raiseDisputeSchema,
  rateLeadSchema,
  updateConsentSchema,
  withdrawConsentSchema,
  requestDeletionSchema,
  reopenTicketSchema,
  verifyTicketSchema,
  ticketCommentSchema,
  cancelLeadSchema,
};
