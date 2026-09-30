const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const createOrderSchema = z.object({
  leadId: objectId,
  amount: z.number({
    required_error: 'amount is required',
    invalid_type_error: 'amount must be a number',
  }).positive('amount must be a positive number').min(1, 'Minimum escrow amount is ₹1'),
});

const releaseEscrowSchema = z.object({
  sellerAccountId: z.string().min(1).optional(),
  // If there's no Razorpay account to transfer to (a manual/offline payout),
  // this must be explicitly set — previously omitting sellerAccountId
  // silently skipped the Razorpay transfer entirely while still marking the
  // escrow RELEASED, with no record of why no money moved through Razorpay.
  manualTransferConfirmed: z.boolean().optional(),
  partnerShare:    z.number().positive().optional(),
  platformFee:     z.number().positive().optional(),
  note:            z.string().max(500).optional(),
}).refine(
  (data) => !!data.sellerAccountId || data.manualTransferConfirmed === true,
  { message: 'Provide sellerAccountId for a Razorpay transfer, or set manualTransferConfirmed to true if the payout was made outside Razorpay', path: ['sellerAccountId'] }
).refine(
  (data) => !data.manualTransferConfirmed || !!data.note,
  { message: 'A note is required to record how/why a manual transfer was made', path: ['note'] }
);

module.exports = { createOrderSchema, releaseEscrowSchema };
