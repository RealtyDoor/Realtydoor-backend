// Generates admin-nextjs/docs/API_REFERENCE.md from the real routers, so the reference cannot drift from the code.
// Run (not part of the normal test run):
//   npx jest --testMatch "**/scripts/genApiReference.jest.js" --forceExit
// It loads src/routes (and the webhook router), tags each gate (sign-in, role, permission, KYC, phone, object-id check) and
// writes one table per area: method, path, who may call it, extra gates, and the controller function name.
process.env.NODE_ENV = 'test';
process.env.WATI_TEMPLATE_EDITING = 'true';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_dummy';
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => Promise.reject(new Error('db')), apply: () => Promise.reject(new Error('db')) }) }));

const tag = (fn, t) => Object.assign(fn, { gate: t });
jest.mock('../src/middleware/auth', () => ({ authenticate: Object.assign((req, res, next) => next(), { gate: { kind: 'auth' } }) }));
jest.mock('../src/middleware/requireRole', () => {
  const requireRole = (...roles) => Object.assign((req, res, next) => next(), { gate: { kind: 'role', roles } });
  return { requireRole, requireAdmin: requireRole('ADMIN'), requirePartner: requireRole('PARTNER', 'ADMIN'), requireUser: requireRole('USER', 'PARTNER', 'ADMIN') };
});
jest.mock('../src/middleware/requirePermission', () => ({ requirePermission: (scope) => Object.assign((req, res, next) => next(), { gate: { kind: 'perm', scopes: [].concat(scope) } }) }));
jest.mock('../src/middleware/requireKyc', () => ({ requireKyc: Object.assign((req, res, next) => next(), { gate: { kind: 'kyc' } }) }));
jest.mock('../src/middleware/requirePhone', () => ({ requirePhone: Object.assign((req, res, next) => next(), { gate: { kind: 'phone' } }) }));
jest.mock('../src/middleware/validateObjectId', () => ({ validateObjectId: (n) => Object.assign((req, res, next) => next(), { gate: { kind: 'oid', param: n } }) }));
jest.mock('../src/middleware/salesOnly', () => ({ restrictSalesOnly: Object.assign((req, res, next) => next(), { gate: { kind: 'salesOnly' } }) }));
jest.mock('../src/middleware/honeypot', () => Object.assign((req, res, next) => next(), { gate: { kind: 'honeypot' } }));

const fs = require('fs');
const path = require('path');

function mountPathOf(layer) {
  if (layer.regexp.fast_slash) return '';
  const m = layer.regexp.source.match(/^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) return '';
  return m[1].replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/:p').replace(/\\\//g, '/');
}
function flatten(router, prefix = '', inherited = []) {
  const out = [];
  const uses = [...inherited];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        const chain = layer.route.stack.map((l) => l.handle);
        const handler = chain[chain.length - 1];
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, gates: [...uses, ...chain.slice(0, -1)].map((f) => f.gate).filter(Boolean), handler: handler.name || '(inline)' });
      }
    } else if (layer.handle && layer.handle.stack) {
      out.push(...flatten(layer.handle, prefix + mountPathOf(layer), uses));
    } else if (layer.handle && layer.handle.gate) {
      uses.push(layer.handle);
    }
  }
  return out;
}

function who(gates) {
  const g = (k) => gates.filter((x) => x.kind === k);
  if (!g('auth').length && !g('role').length) return 'Public (no sign-in)';
  const roles = g('role').map((x) => x.roles.join(' or ')).filter((r, i, a) => a.indexOf(r) === i);
  const role = roles.length ? roles[roles.length - 1] : 'any signed-in user';
  const perm = g('perm').map((x) => x.scopes.join(' or '));
  return role + (perm.length ? `, permission ${perm[perm.length - 1]}` : '');
}
function extras(gates) {
  const e = [];
  if (gates.some((x) => x.kind === 'kyc')) e.push('KYC verified');
  if (gates.some((x) => x.kind === 'phone')) e.push('phone verified');
  if (gates.some((x) => x.kind === 'honeypot')) e.push('form trap');
  if (gates.some((x) => x.kind === 'oid')) e.push('id must be an ObjectId');
  return e.join(', ');
}

test('write the API reference', () => {
  const root = require('../src/routes');
  const hooks = require('../src/modules/webhooks/webhooks.routes');
  const routes = [
    { method: 'GET', path: '/health', gates: [], handler: '(inline)' },
    { method: 'GET', path: '/api/health', gates: [], handler: '(inline)' },
    ...flatten(hooks, '/api/webhooks'),
    ...flatten(root, '/api'),
  ];
  const area = (p) => { const s = p.split('/').filter(Boolean); return s[0] === 'api' ? (s[1] === 'admin' ? `admin${s[2] ? '/' + s[2] : ''}` : s[1] || 'api') : s[0]; };
  const bigAdmin = (a) => (a.startsWith('admin/') ? 'admin' : a);
  const groups = {};
  for (const r of routes) (groups[bigAdmin(area(r.path))] ||= []).push(r);
  const names = Object.keys(groups).sort((a, b) => (a === 'admin') - (b === 'admin') || a.localeCompare(b));

  const today = new Date().toISOString().slice(0, 10);
  let md = `# API reference (generated ${today})\n\n`;
  md += `**Generated from the real routers by \`Rbac/realtydoorBackend/scripts/genApiReference.jest.js\`; do not edit by hand.** Regenerate after changing any route:\n\n\`\`\`bash\ncd Rbac/realtydoorBackend && npx jest --testMatch "**/scripts/genApiReference.jest.js" --forceExit\n\`\`\`\n\n`;
  md += `${routes.length} routes. All paths are under the API host (\`https://api.realtydoor.in\` on the test setup, \`http://localhost:5000\` locally); the website proxies \`/api/*\` to it.\n\n`;
  md += `## How to read it\n- **Who:** *Public* needs no sign-in. Otherwise the role(s) allowed (\`USER\` buyer, \`PARTNER\`, \`ADMIN\`); \`requirePartner\` lets \`ADMIN\` through too. Admin routes add a **permission** (any one listed is enough; owners, SUPER_ADMIN and admins with no staff role pass every permission). A sales-only BDE reaches only 7 lead routes.\n- **Gates:** *KYC verified* (partner routes, 403 \`KYC_REQUIRED\`), *phone verified* (403 \`PHONE_NOT_VERIFIED\`), *form trap* (hidden field; public forms), *id must be an ObjectId* (400 otherwise).\n- **Handler:** the controller function, to find the code. Request bodies are validated with zod in each module's \`*.validator.js\`; a bad body, query or id is a 400, never a 500.\n- **Rate limits** (per client address unless noted): all of \`/api\` has a global limit (\`RATE_LIMIT_IP_MAX\`, per user \`RATE_LIMIT_USER_MAX\`); property search and locality report 30 a minute; public forms 10 an hour; OTP routes 5 to 20 per window; uploads 50 an hour.\n- **Response shape:** \`{ success, message, data }\`; errors carry \`data.code\` (for example \`VALIDATION_ERROR\`, \`NOT_FOUND\`, \`KYC_REQUIRED\`, \`LEAD_OTP_LOCKED\`, \`RAZORPAY_ERROR\`).\n- **Webhooks** are signed or tokened, not session-authenticated: Razorpay (HMAC with \`RAZORPAY_WEBHOOK_SECRET\`), Clerk (Svix), WATI (\`?token=\`), lead intake (per-source key).\n\n`;
  md += `## Areas\n${names.map((n) => `- [${n}](#${n.replace(/[^a-z0-9]+/g, '-')}) (${groups[n].length})`).join('\n')}\n\n`;
  for (const n of names) {
    md += `## ${n}\n\n| Method | Path | Who | Gates | Handler |\n|---|---|---|---|---|\n`;
    for (const r of groups[n].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
      md += `| ${r.method} | \`${r.path}\` | ${who(r.gates)} | ${extras(r.gates)} | \`${r.handler}\` |\n`;
    }
    md += '\n';
  }
  const out = path.join(__dirname, '../../../admin-nextjs/docs/API_REFERENCE.md');
  fs.writeFileSync(out, md);
  expect(routes.length).toBeGreaterThan(400);
});
