'use strict';

const { z } = require('zod');

// What the browser sends back after Razorpay checkout. All three are short ids/hex strings; anything else (an object, an array, a
// 10 MB string) is a bad request, not something to hand to the database or the signature check.
const ID = (name) => z.string({ required_error: `${name} is required`, invalid_type_error: `${name} must be text` })
  .trim().min(1, `${name} is required`).max(100, `${name} is too long`).regex(/^[A-Za-z0-9_]+$/, `${name} is not valid`);

const verifyPaymentSchema = z.object({
  razorpayOrderId: ID('razorpayOrderId'),
  razorpayPaymentId: ID('razorpayPaymentId'),
  razorpaySignature: z.string({ required_error: 'razorpaySignature is required', invalid_type_error: 'razorpaySignature must be text' })
    .trim().min(1, 'razorpaySignature is required').max(200).regex(/^[A-Fa-f0-9]+$/, 'razorpaySignature is not valid'),
});

module.exports = { verifyPaymentSchema };
