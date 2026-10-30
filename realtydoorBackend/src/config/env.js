const { z } = require('zod');

const envSchema = z.object({
  // Security fix, 2026-10-13 (B3) — no default. The dev-bypass gate
  // (middleware/auth.js) and the two .refine() checks below all key off
  // `NODE_ENV === 'production'`; a defaulted 'development' meant a deploy
  // that simply forgot to set NODE_ENV silently became "not production" in
  // every one of those checks, so DEV_API_KEY (a full, unauthenticated
  // login-as-anyone bypass) could sit active on a real internet-facing box
  // with no validation error ever firing. Every real environment (.env,
  // .env.example, Jest's own built-in default) already sets this
  // explicitly — this only breaks a boot that genuinely forgot it, which
  // is exactly the case that needs to fail loudly instead of silently.
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().min(1),
  WATI_API_ENDPOINT: z.string().url(),
  WATI_ACCESS_TOKEN: z.string().min(1),
  // Security fix, 2026-10-13 (B2) — optional meant the webhook accepted
  // unauthenticated requests whenever this wasn't set (wati.handler.js's
  // check only runs `if (token && ...)`). Still optional outside
  // production so local/dev setups that never configured WATI don't need
  // a throwaway value — required once NODE_ENV is actually 'production',
  // enforced by the .refine() below.
  WATI_WEBHOOK_TOKEN: z.string().optional(),
  // Optional: on AWS the task's IAM role supplies S3 credentials. Local setups use a key pair; a lone key is refused below.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),
  GMAIL_APP_PASSWORD: z.string().min(1),
  EMAIL_FROM: z.string().email(),
  // FRONTEND_URL is the public site address that emails and PDFs build their links from, so it is always required. FRONTEND_URLS is an
  // optional comma-separated list of every allowed origin for CORS (src/app.js reads it first); set it when more than one host calls the API.
  FRONTEND_URL: z.string().url(),
  FRONTEND_URLS: z.string().optional(),
  REDIS_URL: z.string().optional(),
  OTP_EXPIRY_MINUTES: z.string().default('120'),
  OTP_MAX_ATTEMPTS: z.string().default('3'),
  OTP_HASH_SECRET: z.string().min(16, 'OTP_HASH_SECRET must be at least 16 characters'),
  DEV_EXPOSE_OTP: z.string().optional(),
  DEV_API_KEY: z.string().optional(),
}).refine(
  (env) => Boolean(env.AWS_ACCESS_KEY_ID) === Boolean(env.AWS_SECRET_ACCESS_KEY),
  { message: 'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither (neither = use the task IAM role).', path: ['AWS_ACCESS_KEY_ID'] }
).refine(
  (env) => !(env.NODE_ENV === 'production' && env.DEV_EXPOSE_OTP === 'true'),
  { message: 'DEV_EXPOSE_OTP must not be set to "true" in production — it echoes real OTP codes in API responses.', path: ['DEV_EXPOSE_OTP'] }
).refine(
  (env) => !(env.NODE_ENV === 'production' && env.DEV_API_KEY),
  { message: 'DEV_API_KEY must not be set in production — it is a full auth bypass with no password/signature check.', path: ['DEV_API_KEY'] }
).refine(
  (env) => !(env.NODE_ENV === 'production' && !env.WATI_WEBHOOK_TOKEN),
  { message: 'WATI_WEBHOOK_TOKEN must be set in production — without it, the WATI webhook accepts unauthenticated requests (fake replies, fake delivery events).', path: ['WATI_WEBHOOK_TOKEN'] }
);

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:\n', result.error.flatten().fieldErrors);
    process.exit(1);
  }
}

module.exports = { validateEnv };
