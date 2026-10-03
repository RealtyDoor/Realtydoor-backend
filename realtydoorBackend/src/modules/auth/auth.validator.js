const { z } = require('zod');
const { phoneField } = require('../../lib/phoneUtils');

const codeField = z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be numeric');

const signupOtpSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
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
