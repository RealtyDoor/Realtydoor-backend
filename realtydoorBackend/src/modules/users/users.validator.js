const { z } = require('zod');
const { indianPhone, objectId } = require('../../utils/validators');

const requestPhoneOtpSchema = z.object({
  phone: indianPhone,
});

const verifyPhoneOtpSchema = z.object({
  otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

const toggleFavoriteSchema = z.object({
  propertyId: objectId,
});

const DOCUMENT_TYPES = ['PAN_CARD', 'AADHAR', 'SALARY_SLIP', 'FORM_16', 'BANK_STATEMENT'];

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
});

const createLoanSchema = z.object({
  propertyId: objectId.optional(),
  preferredBank: z.string().max(100).optional(),
  loanAmountRequestedPaise: z.number().int().positive().optional(),
});

const updateProfileSchema = z.object({
  name:  z.string().min(2).max(100).optional(),
  isNRI: z.boolean().optional(),
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
};
