// The single source of truth for settings (src/config/productionSpec.js) and for what we need from Clerk (src/config/clerkManifest.js):
// everything else (startup check, .env.example, the runbook table, the Clerk checklist) must agree with them, and the code must not read a
// setting that is not listed.
const fs = require('fs');
const path = require('path');
const { SPEC, check } = require('../../src/config/productionSpec');
const { renderEnvExample, renderRunbookTable, replaceBlock } = require('../../src/config/renderConfigDocs');
const clerk = require('../../src/config/clerkManifest');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const sources = [...walk(path.join(root, 'src')), path.join(root, 'server.js')];
const code = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const readKeys = new Set([...code.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]));
// DATABASE_URL is read by Prisma from the schema, not by our code.
readKeys.add('DATABASE_URL');
const backendKeys = new Set(SPEC.filter((s) => s.scope === 'backend').map((s) => s.key));

describe('every setting the API reads is in the spec, and every spec entry is read', () => {
  test('nothing is read that the spec does not list', () => {
    expect([...readKeys].filter((k) => !backendKeys.has(k)).sort()).toEqual([]);
  });
  test('nothing is listed that no code reads', () => {
    expect([...backendKeys].filter((k) => !readKeys.has(k)).sort()).toEqual([]);
  });
  test('no key is listed twice in one scope', () => {
    const seen = SPEC.map((s) => `${s.scope}:${s.key}`);
    expect(seen.length).toBe(new Set(seen).size);
  });
});

describe('the generated documents match the spec', () => {
  test('.env.example is what the spec says', () => {
    expect(fs.readFileSync(path.join(root, '.env.example'), 'utf8')).toBe(renderEnvExample() + '\n');
  });
  test('the runbook table is what the spec says (when the other repository is there)', () => {
    const f = path.join(root, '../../admin-nextjs/docs/production-release-runbook.md');
    if (!fs.existsSync(f)) return;
    const md = fs.readFileSync(f, 'utf8');
    expect(replaceBlock(md, renderRunbookTable())).toBe(md);
  });
  test('no real secret value can end up in .env.example', () => {
    const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const s of SPEC.filter((x) => x.scope === 'backend' && x.secret)) expect(text).toMatch(new RegExp(`^${s.key}=$`, 'm'));
  });
});

describe('the boot check', () => {
  const GOOD = {
    NODE_ENV: 'production', DATABASE_URL: 'mongodb+srv://x', CLERK_SECRET_KEY: 'sk_test_x', CLERK_WEBHOOK_SECRET: 'w', RAZORPAY_KEY_ID: 'rzp_test_x',
    RAZORPAY_KEY_SECRET: 'k', RAZORPAY_WEBHOOK_SECRET: 'k', RAZORPAYX_ACCOUNT_NUMBER: '1', WATI_API_ENDPOINT: 'https://w', WATI_ACCESS_TOKEN: 't',
    WATI_WEBHOOK_TOKEN: 't', AWS_REGION: 'r', AWS_S3_BUCKET: 'b', GMAIL_APP_PASSWORD: 'p', EMAIL_FROM: 'a@b.in', FRONTEND_URL: 'https://www.realtydoor.com',
    OTP_HASH_SECRET: 'x'.repeat(16), AUDIT_HMAC_SECRET: 'y'.repeat(16),
  };
  const fails = (env, o) => check(env, o).filter((p) => p.level === 'fail').map((p) => p.key);
  test('a complete production environment boots, even with test payment keys (a staging run)', () => {
    expect(fails(GOOD)).toEqual([]);
  });
  test.each([
    ['DEV_API_KEY'], ['DEV_EXPOSE_OTP'], ['NEXT_PUBLIC_BYPASS_USER_AUTH'],
  ])('%s set in production is a refusal (when it belongs to the scope)', (key) => {
    const scope = SPEC.find((s) => s.key === key).scope;
    expect(fails({ ...GOOD, [key]: 'true' }, { scope })).toContain(key);
  });
  test('DEV_EXPOSE_OTP=false is fine', () => {
    expect(fails({ ...GOOD, DEV_EXPOSE_OTP: 'false' })).toEqual([]);
  });
  test('the audit secret must exist, be long enough, and differ from the OTP secret', () => {
    expect(fails({ ...GOOD, AUDIT_HMAC_SECRET: undefined })).toContain('AUDIT_HMAC_SECRET');
    expect(fails({ ...GOOD, AUDIT_HMAC_SECRET: 'short' })).toContain('AUDIT_HMAC_SECRET');
    expect(fails({ ...GOOD, AUDIT_HMAC_SECRET: GOOD.OTP_HASH_SECRET })).toContain('AUDIT_HMAC_SECRET');
  });
  test('outside production the audit secret and the WATI webhook token are not required', () => {
    const { AUDIT_HMAC_SECRET, WATI_WEBHOOK_TOKEN, ...rest } = GOOD;
    expect(fails({ ...rest, NODE_ENV: 'development' }, { production: false })).toEqual([]);
  });
  test('test-only helpers set in production are warned about, not refused at boot', () => {
    const r = check({ ...GOOD, WATI_ALLOWED_NUMBERS: '9800000001', RATE_LIMIT_IP_MAX: '20000' });
    expect(r.filter((p) => p.level === 'warn').map((p) => p.key).sort()).toEqual(['RATE_LIMIT_IP_MAX', 'WATI_ALLOWED_NUMBERS']);
  });
  test('a message never contains a value', () => {
    const secret = 'SUPERSECRETVALUE123456';
    const r = check({ ...GOOD, DEV_API_KEY: secret, OTP_HASH_SECRET: secret, AUDIT_HMAC_SECRET: secret });
    expect(JSON.stringify(r)).not.toContain(secret);
  });
  test('the server startup check is built on the spec', () => {
    expect(read('src/config/env.js')).toMatch(/require\('\.\/productionSpec'\)/);
    expect(read('src/config/env.js')).toMatch(/check\(process\.env, \{ profile: 'boot' \}\)/);
  });
});

describe('the launch bar', () => {
  const LIVE = {
    NODE_ENV: 'production', DATABASE_URL: 'mongodb+srv://x', CLERK_SECRET_KEY: 'sk_live_x', CLERK_WEBHOOK_SECRET: 'w', RAZORPAY_KEY_ID: 'rzp_live_x',
    RAZORPAY_KEY_SECRET: 'k', RAZORPAY_WEBHOOK_SECRET: 'k', RAZORPAYX_ACCOUNT_NUMBER: '1', WATI_API_ENDPOINT: 'https://w', WATI_ACCESS_TOKEN: 't',
    WATI_WEBHOOK_TOKEN: 't', AWS_REGION: 'r', AWS_S3_BUCKET: 'b', GMAIL_APP_PASSWORD: 'p', EMAIL_FROM: 'a@b.in', FRONTEND_URL: 'https://www.realtydoor.com',
    FRONTEND_URLS: 'https://www.realtydoor.com', ADMIN_ALERT_EMAILS: 'a@b.in', TRUST_PROXY_HOPS: '2', OTP_HASH_SECRET: 'x'.repeat(16), AUDIT_HMAC_SECRET: 'y'.repeat(16),
  };
  const fails = (env) => check(env, { profile: 'launch' }).filter((p) => p.level === 'fail').map((p) => p.key);
  test('a complete live environment is ready', () => expect(fails(LIVE)).toEqual([]));
  test('test keys, a local address, or a development NODE_ENV are not ready', () => {
    expect(fails({ ...LIVE, CLERK_SECRET_KEY: 'sk_test_x' })).toContain('CLERK_SECRET_KEY');
    expect(fails({ ...LIVE, RAZORPAY_KEY_ID: 'rzp_test_x' })).toContain('RAZORPAY_KEY_ID');
    expect(fails({ ...LIVE, FRONTEND_URL: 'http://localhost:3000' })).toContain('FRONTEND_URL');
    expect(fails({ ...LIVE, NODE_ENV: 'development' })).toContain('NODE_ENV');
    expect(fails({ ...LIVE, DATABASE_URL: 'mongodb://localhost:27017/x' })).toContain('DATABASE_URL');
  });
  test('the launch-only settings must be set explicitly', () => {
    for (const k of ['FRONTEND_URLS', 'ADMIN_ALERT_EMAILS', 'TRUST_PROXY_HOPS']) expect(fails({ ...LIVE, [k]: undefined })).toContain(k);
  });
  test('test helpers still set are a failure at launch, not a warning', () => {
    expect(fails({ ...LIVE, WATI_ALLOWED_NUMBERS: '9800000001' })).toContain('WATI_ALLOWED_NUMBERS');
  });
  test('the website scope has its own live-key checks', () => {
    const web = (env) => check(env, { profile: 'launch', scope: 'web' }).filter((p) => p.level === 'fail').map((p) => p.key);
    expect(web({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_live_x', NEXT_PUBLIC_API_BASE_URL: 'https://api' })).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  });
});

describe('the Clerk manifest agrees with the code', () => {
  test('the webhook events are the ones the handler serves', () => {
    const handler = read('src/modules/webhooks/clerk.handler.js');
    const served = [...handler.matchAll(/type === '(user\.[a-z]+)'/g)].map((m) => m[1]);
    expect([...clerk.webhook.events].sort()).toEqual([...new Set(served)].sort());
    expect(read('src/modules/webhooks/webhooks.routes.js')).toContain(`'/${clerk.webhook.path.split('/').pop()}'`);
  });
  test('the roles are the database roles', () => {
    const base = read('prisma/schema/_base.prisma');
    const body = base.slice(base.indexOf('enum Role {'), base.indexOf('}', base.indexOf('enum Role {')));
    expect([...body.matchAll(/^\s+([A-Z_]+)\s*$/gm)].map((m) => m[1]).sort()).toEqual([...clerk.roles].sort());
  });
  test('the fields our signup sends to Clerk are the ones listed', () => {
    const svc = read('src/modules/auth/auth.service.js');
    const call = svc.slice(svc.indexOf('clerk.users.createUser({'), svc.indexOf('});', svc.indexOf('clerk.users.createUser({')));
    const sent = [...call.matchAll(/^\s+([a-zA-Z]+)(?::|,)/gm)].map((m) => m[1]);
    expect(sent.sort()).toEqual([...clerk.createUserFields].sort());
  });
  test('the redirect paths are the ones in the website .env.example (when the other repository is there)', () => {
    const f = path.join(root, '../../admin-nextjs/.env.example');
    if (!fs.existsSync(f)) return;
    const env = fs.readFileSync(f, 'utf8');
    for (const [k, v] of Object.entries(clerk.paths)) expect(env).toMatch(new RegExp(`^${k}=${v.replace(/\//g, '\\/')}$`, 'm'));
  });
  test('the manifest turns Email on because our signup sends an email address to Clerk', () => {
    expect(clerk.createUserFields).toContain('emailAddress');
    const rows = clerk.settings.filter((s) => s.area === 'User & authentication > Email');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.value.startsWith('on')).toBe(true);
  });
  test('every setting says where it comes from, and a risk is never hidden', () => {
    for (const s of clerk.settings) {
      expect(['CODE', 'OBSERVED', 'DECIDED']).toContain(s.source);
      expect(s.area && s.setting && s.value).toBeTruthy();
    }
  });
});
