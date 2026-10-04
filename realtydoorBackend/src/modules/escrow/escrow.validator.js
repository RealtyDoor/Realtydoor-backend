const { z } = require('zod');
const { objectId, indianPhone } = require('../../utils/validators');

const createOrderSchema = z.object({
  leadId: objectId,
  amount: z.number({
    required_error: 'amount is required',
    invalid_type_error: 'amount must be a number',
  }).positive('amount must be a positive number').min(1, 'Minimum escrow amount is ₹1'),
});

const bankDetailsSchema = z.object({
  name:          z.string().min(1),
  email:         z.string().email(),
  phone:         indianPhone,
  ifsc:          z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  accountNumber: z.string().min(1),
});

const releaseEscrowSchema = z.object({
  sellerDetails: bankDetailsSchema.optional(),
  // Optional second RazorpayX payout, paid out of the same escrow amount —
  // only triggered if both partnerDetails and a positive partnerShare are
  // given. Omit it to keep recording partnerShare as a manual/off-platform
  // split, same as before.
  partnerDetails: bankDetailsSchema.optional(),
  // If there's no bank account to pay out to (a manual/offline payout), this
  // must be explicitly set — previously omitting sellerAccountId silently
  // skipped the Razorpay transfer entirely while still marking the escrow
  // RELEASED, with no record of why no money moved through Razorpay.
  manualTransferConfirmed: z.boolean().optional(),
  partnerShare:    z.number().positive().optional(),
  platformFee:     z.number().positive().optional(),
  note:            z.string().max(500).optional(),
  // 2.9 — release conditions are enforced in the service. A deal settled out
  // of the normal sequence still has to be closable, so admin can override,
  // but only with a reason, and the override is logged and audited.
  overrideConditions: z.boolean().optional(),
  overrideReason:     z.string().min(5).max(500).optional(),
}).refine(
  (data) => !data.overrideConditions || !!data.overrideReason,
  { message: 'overrideReason is required when overriding release conditions', path: ['overrideReason'] }
).refine(
  (data) => !!data.sellerDetails || data.manualTransferConfirmed === true,
  { message: 'Provide sellerDetails for a RazorpayX payout, or set manualTransferConfirmed to true if the payout was made outside Razorpay', path: ['sellerDetails'] }
).refine(
  (data) => !data.manualTransferConfirmed || !!data.note,
  { message: 'A note is required to record how/why a manual transfer was made', path: ['note'] }
).refine(
  (data) => !data.partnerDetails || (data.partnerShare != null && data.partnerShare > 0),
  { message: 'partnerShare is required (and must be positive) when partnerDetails is provided', path: ['partnerShare'] }
);

module.exports = { createOrderSchema, releaseEscrowSchema };
