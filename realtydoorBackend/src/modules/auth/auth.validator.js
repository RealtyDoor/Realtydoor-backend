const { z } = require('zod');
const { phoneField } = require('../../lib/phoneUtils');

const codeField = z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be numeric');

// Email addresses are case-insensitive for delivery (RFC 5321's local-part
// sensitivity is theoretical — no real-world mailbox provider honours it),
// but were being compared/stored with raw case everywhere: the duplicate
// pre-check (auth.service.js::signupOtp) and the DB's partial unique index
// are both exact, case-sensitive matches. Confirmed live: "test@x.com" and
// "Test@X.com" sailed past both and created two separate accounts for the
// same real mailbox — exactly what let a user (or partner) "duplicate
// signup". Normalizing once here, at the single entry point for phone-OTP
// signup, is enough for that path; syncUserByClerkId does the same for the
// Google path, since Clerk-sourced email never passes through this schema.
const emailField = z.string().email().transform((e) => e.toLowerCase().trim());

const signupOtpSchema = z.object({
  name: z.string().min(2).max(100),
  email: emailField,
  phone: phoneField,
  isNRI: z.boolean().optional().default(false),
  marketingOptIn: z.boolean().optional().default(false),
  // Lets this same signup flow create a PARTNER account directly, instead of
  // every partner having to sign up as USER first and self-upgrade via
  // POST /auth/set-role. ADMIN is deliberately not a valid value here — that
  // role is never self-assignable at signup.
  role: z.enum(['USER', 'PARTNER']).optional().default('USER'),
});

const signupVerifySchema = z.object({
  phone: phoneField,
  code: codeField,
});

const loginOtpSchema = z.object({
  phone: phoneField,
});

const loginVerifySchema = z.object({
  phone: phoneField,
  code: codeField,
});

const googlePhoneOtpSchema = z.object({
  phone: phoneField,
});

const googlePhoneVerifySchema = z.object({
  phone: phoneField,
  code: codeField,
});

module.exports = {
  signupOtpSchema,
  signupVerifySchema,
  loginOtpSchema,
  loginVerifySchema,
  googlePhoneOtpSchema,
  googlePhoneVerifySchema,
};
