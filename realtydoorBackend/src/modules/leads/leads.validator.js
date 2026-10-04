const { z } = require('zod');
const { objectId } = require('../../utils/validators');
const { phoneField } = require('../../lib/phoneUtils');

// B3.1 — partner logs a buyer they sourced themselves. Unlike submitLeadSchema
// below, contact details ARE accepted here: there's no authenticated buyer to
// snapshot them from, the partner is vouching for someone else. phoneField
// (not a bare 10-digit rule) so it normalizes to E.164 the same as every other
// phone input, and NRI numbers still work.
const partnerAddLeadSchema = z.object({
  buyerName:  z.string().min(2).max(100),
  buyerPhone: phoneField,
  buyerEmail: z.string().email().optional(),
  propertyId: objectId,
  budget:     z.string().max(100).optional(),
  note:       z.string().max(1000).optional(),
});

// buyerName/buyerEmail/buyerPhone are no longer accepted from the client —
// name/email/phone are always a snapshot of the authenticated, phone-verified
// account (see leads.service.js's submitLead). Previously a submitted
// buyerPhone didn't have to match the account making the request at all.
const submitLeadSchema = z.object({
  propertyId:   objectId,
  buyerName:    z.string().min(2).max(100).optional(),
  buyerMessage: z.string().max(500).optional(),
});

const scheduleVisitSchema = z.object({
  scheduledAt: z.string().datetime().refine(
    (d) => new Date(d) > new Date(),
    { message: 'Visit must be scheduled in the future' }
  ),
});

const verifyOtpSchema = z.object({
  // 6 digits (lib/otp.js). Any 4-digit codes still live in the DB when this
  // shipped fail length validation rather than verifying — those leads need a
  // resend to get a 6-digit code. Digits-only, so a wrong-length or
  // non-numeric entry 400s here instead of burning an OTP attempt.
  otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

const uploadDocsSchema = z.object({
  visitNotes: z.string().max(1000).optional(),
  partnerNotes: z.string().max(1000).optional(),
});

// CLOSED/DROPPED are intentionally not accepted — they have their own guarded
// endpoints (close needs a HELD escrow per Rule 6; request-drop needs admin
// approval). The error message points the client at them rather than silently
// rejecting a value the design's picker offers.
const VISIT_OUTCOMES = ['STILL_DECIDING', 'WANTS_ANOTHER_VISIT', 'NEGOTIATING'];
const updateVisitOutcomeSchema = z.object({
  outcome: z.enum(VISIT_OUTCOMES, {
    errorMap: () => ({
      message: `outcome must be one of: ${VISIT_OUTCOMES.join(', ')}. Use /close to close a deal or /request-drop to drop it.`,
    }),
  }),
  note: z.string().max(1000).optional(),
});

// B5.1 — the closing price agreed with the buyer, recorded at close. Optional
// so the existing no-body call still works; listed price and token amount are
// already derivable from the property and the escrow record.
const closeLeadSchema = z.object({
  closingPrice: z.number().positive().optional(),
});

const requestDropSchema = z.object({
  reason: z.string().min(5, 'Please provide a meaningful reason (min 5 characters)').max(500),
});

module.exports = { submitLeadSchema, partnerAddLeadSchema, scheduleVisitSchema, verifyOtpSchema, uploadDocsSchema, requestDropSchema, updateVisitOutcomeSchema, closeLeadSchema };
