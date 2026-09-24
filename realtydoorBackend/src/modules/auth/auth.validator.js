const { z } = require('zod');
const { normalizeIndianPhone } = require('../../lib/phoneUtils');

const phoneField = z.string().transform((val, ctx) => {
  const normalized = normalizeIndianPhone(val);
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid Indian mobile number' });
    return z.NEVER;
  }
  return normalized;
});

const codeField = z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be numeric');

const signupOtpSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: phoneField,
  isNRI: z.boolean().optional().default(false),
  marketingOptIn: z.boolean().optional().default(false),
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
