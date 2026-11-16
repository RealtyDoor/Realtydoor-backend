'use strict';

// THE single source of truth for every setting the system reads (audit Nov 2026, go-live). Everything else is made from or checked
// against this file:
//   - src/config/env.js enforces the "boot" rules, so a production server refuses to start with a dangerous or missing setting;
//   - scripts/genConfigDocs.js writes .env.example and the settings table of the release runbook from it (a test fails if they drift);
//   - scripts/checkProductionEnv.js checks a real environment against the "launch" rules before a go-live deploy;
//   - tests/unit/productionSpec.test.js fails if the code reads a setting that is not listed here.
// To add a setting: add it here, run `node scripts/genConfigDocs.js`, commit the result.
//
// Fields. scope: 'backend' (the API, read by the server) or 'web' (the website: build = baked into the browser bundle, so public
// values only; runtime = read by the server). boot: what a server running with NODE_ENV=production enforces: 'required',
// 'optional', 'forbidden' (a refusal to start if set) or 'discouraged' (should be unset, warned). launch: the extra bar for the real
// production deploy ('boot' rules plus: live key prefixes, https, no localhost), checked by the preflight script, not at boot, so a
// staging run with test payments can still start.

const GROUPS = [
  ['core', 'Core'], ['db', 'Database and cache'], ['auth', 'Sign-in (Clerk) and secrets'], ['pay', 'Payments (Razorpay)'],
  ['wa', 'WhatsApp (WATI)'], ['mail', 'Email'], ['aws', 'File storage (AWS S3)'], ['net', 'Network, limits and timeouts'],
  ['ops', 'Operations and logging'], ['kyc', 'KYC checks'], ['dev', 'Development only'], ['web', 'Website (Next.js)'],
];

const LIVE_HOST = /^https:\/\/(?!localhost|127\.|.*\.local\b)/i;

const e = (key, group, desc, o = {}) => ({ key, scope: 'backend', group, desc, secret: false, boot: 'optional', launch: null, example: '', default: undefined, ...o });
const w = (key, group, desc, o = {}) => ({ key, scope: 'web', web: 'runtime', group, desc, secret: false, boot: 'optional', launch: null, example: '', default: undefined, ...o });

const SPEC = [
  // ── Core ───────────────────────────────────────────────────────────────
  e('NODE_ENV', 'core', 'development, production or test. No default: a forgotten value must not silently mean "not production".', { boot: 'required', example: 'development', pattern: /^production$/, patternHint: 'must be "production"' }),
  e('PORT', 'core', 'Port the API listens on.', { default: '5000', example: '5000' }),
  e('FRONTEND_URL', 'core', 'Public site address; links in emails and PDFs are built from it.', { boot: 'required', example: 'http://localhost:3000', pattern: LIVE_HOST, patternHint: 'must be an https address, not localhost' }),
  e('FRONTEND_URLS', 'core', 'Every host that may call the API (CORS), https, comma separated: site, app, admin and partner.', { example: 'http://localhost:3000', launchRequired: true }),
  e('SUPPORT_EMAIL', 'core', 'Address shown to users who need help.', { example: 'support@example.com' }),

  // ── Database and cache ───────────────────────────────────────────────
  e('DATABASE_URL', 'db', 'MongoDB connection string. Production: the production Atlas project only.', { boot: 'required', secret: true, example: 'mongodb+srv://USER:PASSWORD@cluster0.mongodb.net/realtydoor?retryWrites=true&w=majority', pattern: /^mongodb\+srv:\/\//, patternHint: 'must be an Atlas mongodb+srv address' }),
  e('REDIS_URL', 'db', 'Response cache. Optional: without it the API works, slower.', { secret: true, example: '' }),

  // ── Sign-in and secrets ───────────────────────────────────────────────
  e('CLERK_SECRET_KEY', 'auth', 'Clerk secret key of the instance in use. Production: the production instance (sk_live_).', { boot: 'required', secret: true, example: 'sk_test_xxxx', pattern: /^sk_live_/, patternHint: 'must be a production key (sk_live_)' }),
  e('CLERK_WEBHOOK_SECRET', 'auth', 'Signing secret of the Clerk webhook (whsec_).', { boot: 'required', secret: true, example: 'whsec_xxxx' }),
  e('OTP_HASH_SECRET', 'auth', 'Secret that hashes one-time codes. Long and random; never reuse a dev value in production.', { boot: 'required', secret: true, min: 16, example: '' }),
  e('AUDIT_HMAC_SECRET', 'auth', 'Signs the audit-log chain. In production it is required, separate from OTP_HASH_SECRET, and must never change afterwards (the chain check would fail). Outside production it may stay empty.', { boot: 'required', bootOnly: 'production', secret: true, min: 16, differsFrom: 'OTP_HASH_SECRET', example: '' }),
  e('OTP_EXPIRY_MINUTES', 'auth', 'How long a one-time code stays valid.', { default: '120', example: '120' }),
  e('OTP_MAX_ATTEMPTS', 'auth', 'Wrong guesses allowed on a one-time code.', { default: '3', example: '3' }),

  // ── Payments ──────────────────────────────────────────────────────────
  e('RAZORPAY_KEY_ID', 'pay', 'Razorpay key id. Real go-live: the live key (rzp_live_). A staging run may use a test key.', { boot: 'required', example: 'rzp_test_xxxx', pattern: /^rzp_live_/, patternHint: 'must be a live key (rzp_live_)' }),
  e('RAZORPAY_KEY_SECRET', 'pay', 'Razorpay key secret (the same pair as the key id).', { boot: 'required', secret: true, example: '' }),
  e('RAZORPAY_WEBHOOK_SECRET', 'pay', 'Signing secret of the Razorpay webhook. A new secret for production.', { boot: 'required', secret: true, example: '' }),
  e('RAZORPAYX_ACCOUNT_NUMBER', 'pay', 'The RazorpayX current account that payouts are made from.', { boot: 'required', example: '' }),
  e('RAZORPAY_TIMEOUT_MS', 'pay', 'Longest wait for a Razorpay call, in milliseconds.', { default: '30000', example: '' }),

  // ── WhatsApp ──────────────────────────────────────────────────────────
  e('WATI_API_ENDPOINT', 'wa', 'WATI API address for your tenant.', { boot: 'required', example: 'https://live-mt-server.wati.io/YOUR_TENANT' }),
  e('WATI_ACCESS_TOKEN', 'wa', 'WATI access token.', { boot: 'required', secret: true, example: '' }),
  e('WATI_WEBHOOK_TOKEN', 'wa', 'The WATI webhook URL carries ?token=<this value>. Required in production: without it the webhook accepts forged requests.', { boot: 'required', bootOnly: 'production', secret: true, example: '' }),
  e('WATI_LIVE_TEMPLATES', 'wa', 'Templates allowed to send (comma separated; they must be approved by Meta).', { example: '' }),
  e('WATI_ALLOWED_NUMBERS', 'wa', 'Test runs only: the only numbers a message may reach. Ignored in production, so every automated message there reaches its real recipient.', { boot: 'discouraged', example: '' }),
  e('WATI_TEMPLATE_EDITING', 'wa', 'Turns on the template editing screens (development tool).', { boot: 'discouraged', example: '' }),

  // ── Email ─────────────────────────────────────────────────────────────
  e('EMAIL_FROM', 'mail', 'From address of every email. Its domain needs correct SPF, DKIM and DMARC records before launch.', { boot: 'required', example: 'noreply@example.com' }),
  e('EMAIL_SMTP_USER', 'mail', 'SMTP user; defaults to EMAIL_FROM.', { example: '' }),
  e('GMAIL_APP_PASSWORD', 'mail', 'App password of the sending Gmail or Google Workspace mailbox.', { boot: 'required', secret: true, example: '' }),
  e('ADMIN_ALERT_EMAILS', 'mail', 'Staff alert emails and the twice-daily digest (comma separated). Empty sends nothing.', { example: '', launchRequired: true }),
  e('EMAIL_ALLOWED_RECIPIENTS', 'mail', 'Test runs only: the only addresses an email may reach. Ignored in production.', { boot: 'discouraged', example: '' }),

  // ── File storage ──────────────────────────────────────────────────────
  e('AWS_REGION', 'aws', 'Region of the S3 bucket and of the server.', { boot: 'required', example: 'ap-south-2' }),
  e('AWS_S3_BUCKET', 'aws', 'The S3 bucket for uploads (KYC papers, listing photos, documents).', { boot: 'required', example: '' }),
  e('AWS_ACCESS_KEY_ID', 'aws', 'Local key pair only. On AWS leave both unset so the task role supplies credentials (set both or neither).', { secret: true, example: '' }),
  e('AWS_SECRET_ACCESS_KEY', 'aws', 'See AWS_ACCESS_KEY_ID.', { secret: true, example: '' }),
  e('TRUSTED_MEDIA_HOSTS', 'aws', 'Extra hosts (besides the bucket) whose https links count as our own media.', { example: '' }),

  // ── Network, limits and timeouts ─────────────────────────────────────
  e('TRUST_PROXY_HOPS', 'net', 'How many proxies sit in front of the API: 2 behind Cloudflare plus a tunnel or ALB. Too low and every visitor looks like one address.', { default: '1', example: '1', launchRequired: true }),
  e('RATE_LIMIT_IP_MAX', 'net', 'Requests per address per 15 minutes. Leave unset in production (default 1000); a large test value must not reach production.', { boot: 'discouraged', default: '1000', example: '' }),
  e('RATE_LIMIT_USER_MAX', 'net', 'Requests per signed-in user per 15 minutes. Leave unset in production (default 300).', { boot: 'discouraged', default: '300', example: '' }),
  e('UPLOAD_RATE_LIMIT_USER_MAX', 'net', 'Uploads per account per hour.', { default: '120', example: '' }),
  e('WEBHOOK_RATE_LIMIT_MAX', 'net', 'Webhook calls per sender per minute.', { default: '300', example: '' }),
  e('FORM_RATE_LIMIT_MAX', 'net', 'Public form submissions per address per hour.', { example: '' }),
  e('JSON_BODY_LIMIT', 'net', 'Largest JSON request body.', { default: '2mb', example: '' }),
  e('REQUEST_TIMEOUT_MS', 'net', 'A read that takes longer answers 503. Writes are never cut.', { default: '30000', example: '' }),
  e('SHUTDOWN_TIMEOUT_MS', 'net', 'How long a stopping server waits before it exits.', { default: '5000', example: '' }),

  // ── Operations and logging ───────────────────────────────────────────
  e('RUN_JOBS', 'ops', 'Scheduled jobs run on this process unless this is "false". Exactly one server should run them.', { default: 'run', example: '' }),
  e('LOG_LEVEL', 'ops', 'Log detail: error, warn, info or debug.', { default: 'info (debug outside production)', example: '' }),
  e('LOG_TO_FILES', 'ops', 'Set to "false" when the folder is read-only; the console (CloudWatch) is used either way.', { example: '' }),
  e('PRISMA_QUERY_LOG', 'ops', 'Logs every database query. Development tool.', { boot: 'discouraged', example: '' }),
  e('EXPOSE_ERROR_STACK', 'ops', 'Shows error stacks in answers outside production. Ignored in production.', { boot: 'discouraged', example: '' }),

  // ── KYC checks ────────────────────────────────────────────────────────
  e('KYC_VERIFICATION_API_KEY', 'kyc', 'Key of the automatic PAN, GST and RERA check service. Empty means checks stay manual.', { secret: true, example: '' }),
  e('KYC_VERIFICATION_BASE_URL', 'kyc', 'Address of that service.', { example: '' }),

  // ── Development only ──────────────────────────────────────────────────
  e('DEV_API_KEY', 'dev', 'A login-as-anyone key for local testing. The server refuses to start in production if it is set.', { boot: 'forbidden', secret: true, example: '' }),
  e('DEV_EXPOSE_OTP', 'dev', 'Echoes one-time codes in answers. The server refuses to start in production if it is "true".', { boot: 'forbidden', example: '' }),

  // ── Website (Next.js) ────────────────────────────────────────────────
  w('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'web', 'Clerk publishable key, baked in at build time. Production: pk_live_. A change needs a rebuild.', { web: 'build', boot: 'required', pattern: /^pk_live_/, patternHint: 'must be a production key (pk_live_)' }),
  w('CLERK_SECRET_KEY', 'web', 'The same Clerk secret key as the API, for the website server.', { boot: 'required', secret: true, pattern: /^sk_live_/, patternHint: 'must be a production key (sk_live_)' }),
  w('NEXT_PUBLIC_API_BASE_URL', 'web', 'Where the website server reaches the API.', { web: 'build', boot: 'required' }),
  w('NEXT_PUBLIC_SITE_HOST', 'web', 'Public site host (www.realtydoor.com). Set all four hosts together or none.', { web: 'build', launchRequired: true }),
  w('NEXT_PUBLIC_APP_HOST', 'web', 'Buyer app host (app.realtydoor.com).', { web: 'build', launchRequired: true }),
  w('NEXT_PUBLIC_ADMIN_HOST', 'web', 'Admin console host (admin.realtydoor.com).', { web: 'build', launchRequired: true }),
  w('NEXT_PUBLIC_PARTNER_HOST', 'web', 'Partner portal host (partner.realtydoor.com).', { web: 'build', launchRequired: true }),
  w('NEXT_PUBLIC_RAZORPAY_KEY_ID', 'web', 'Razorpay publishable key for checkout. Production: rzp_live_.', { web: 'build', pattern: /^rzp_live_/, patternHint: 'must be a live key (rzp_live_)' }),
  w('NEXT_PUBLIC_RERA_NUMBER', 'web', 'RERA registration number printed on the site.', { web: 'build' }),
  w('NEXT_PUBLIC_BYPASS_USER_AUTH', 'web', 'Skips the buyer sign-in for design work. Development only.', { web: 'build', boot: 'forbidden' }),
  w('TRUST_FORWARDED_HOST', 'web', 'Trust the X-Forwarded-Host header. Leave unset unless the proxy in front replaces Host itself.', { boot: 'discouraged' }),
];

const bySlug = new Map(SPEC.map((s) => [`${s.scope}:${s.key}`, s]));
const get = (key, scope = 'backend') => bySlug.get(`${scope}:${key}`);

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// What is wrong with this environment? profile 'boot' = refusals every production-mode server enforces (also used by src/config/env.js);
// profile 'launch' = the boot rules plus the real go-live bar. Returns [{ key, level: 'fail' | 'warn', message }]. Never returns a value.
function check(env, { profile = 'boot', scope = 'backend', production = true } = {}) {
  const out = [];
  const launch = profile === 'launch';
  for (const s of SPEC.filter((x) => x.scope === scope)) {
    const v = env[s.key];
    const has = present(v);
    const prodOnly = s.bootOnly === 'production';
    const enforced = production || !prodOnly;
    if (s.boot === 'forbidden' && production && has && String(v).toLowerCase() !== 'false' && String(v) !== '0') {
      out.push({ key: s.key, level: 'fail', message: 'must not be set in production' }); continue;
    }
    if (s.boot === 'discouraged' && production && has) out.push({ key: s.key, level: launch ? 'fail' : 'warn', message: 'should be unset in production' });
    if ((s.boot === 'required' && enforced) && !has) { out.push({ key: s.key, level: 'fail', message: 'is required' }); continue; }
    if (launch && s.launchRequired && !has) { out.push({ key: s.key, level: 'fail', message: 'is required for the real launch' }); continue; }
    if (!has) continue;
    if (s.min && String(v).length < s.min) out.push({ key: s.key, level: 'fail', message: `must be at least ${s.min} characters` });
    if (s.differsFrom && env[s.differsFrom] && String(v) === String(env[s.differsFrom])) out.push({ key: s.key, level: 'fail', message: `must differ from ${s.differsFrom}` });
    if (launch && s.pattern && !s.pattern.test(String(v))) out.push({ key: s.key, level: 'fail', message: `for the real launch it ${s.patternHint}` });
  }
  return out;
}

const productionRule = (s) => {
  if (s.boot === 'forbidden') return 'Must be unset (the server refuses to start with it)';
  if (s.boot === 'discouraged') return 'Leave unset';
  if (s.boot === 'required') return `Required${s.bootOnly === 'production' ? ' in production' : ''}${s.min ? `, ${s.min}+ characters` : ''}${s.differsFrom ? `, different from ${s.differsFrom}` : ''}`;
  return s.launchRequired ? 'Required for the real launch' : 'Optional';
};

module.exports = { SPEC, GROUPS, LIVE_HOST, get, check, productionRule, present };
