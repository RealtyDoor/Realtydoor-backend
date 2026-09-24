const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  RAZORPAY_ROUTE_ACCOUNT_ID: z.string().min(1),
  WATI_API_ENDPOINT: z.string().url(),
  WATI_ACCESS_TOKEN: z.string().min(1),
  WATI_WEBHOOK_TOKEN: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email(),
  FRONTEND_URL: z.string().url(),
  REDIS_URL: z.string().optional(),
  OTP_EXPIRY_MINUTES: z.string().default('120'),
  OTP_MAX_ATTEMPTS: z.string().default('3'),
  OTP_HASH_SECRET: z.string().min(16, 'OTP_HASH_SECRET must be at least 16 characters'),
  DEV_EXPOSE_OTP: z.string().optional(),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:\n', result.error.flatten().fieldErrors);
    process.exit(1);
  }
}

module.exports = { validateEnv };
