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
// and document-sharing step had nowhere to land. consent is required (and
// must be the literal boolean true) only when documents are actually being
// submitted — same "required to attest sharing a THIRD PARTY'S/one's OWN
// sensitive documents" reasoning as Lead's buyerConsentAt elsewhere in
// this codebase. consentVersion is optional, not required like
// partners.validator.js's acceptTermsSchema.version — a lighter-weight
// flow than formal partner terms acceptance; accepted and stored when the
// frontend sends one, not required to pass consent when it doesn't yet.
const createLoanSchema = z.object({
  propertyId: objectId.optional(),
  preferredBank: z.string().max(100).optional(),
  loanAmountRequestedPaise: z.number().int().positive().optional(),
  tenureMonths: z.number().int().positive().max(480).optional(),
  submittedDocIds: z.array(objectId).max(20).optional(),
  consent: z.boolean().optional(),
  consentVersion: z.string().min(1).max(40).optional(),
}).refine(
  (d) => !d.submittedDocIds?.length || d.consent === true,
  { message: 'Consent is required to submit documents with this application', path: ['consent'] },
);

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
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

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
  reopenTicketSchema,
  verifyTicketSchema,
  ticketCommentSchema,
  cancelLeadSchema,
};
