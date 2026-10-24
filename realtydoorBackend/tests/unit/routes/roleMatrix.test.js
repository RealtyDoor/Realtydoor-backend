// Route-level role matrix. Walks every route the real app mounts (from src/routes/index.js, so a new route is picked up
// without editing this file), keeps each route's own middleware chain (sign-in, role, KYC, phone, permission checks) and swaps
// only the final controller for a stub. So a 200 here means "this role got past every gate", and nothing touches a database,
// Clerk, WATI, Razorpay or S3.
process.env.NODE_ENV = 'test';
// Never reach a real database: point Prisma at a dead local address and replace the client, so any stray query fails loudly.
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
jest.mock('../../../src/lib/prisma', () => new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => Promise.reject(new Error('database access in a route test')), apply: () => Promise.reject(new Error('database access in a route test')) }) }));
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_dummy';

jest.mock('../../../src/middleware/auditAction', () => ({ auditAction: () => (req, res, next) => next() }));
// Sign-in is replaced by a header that carries the acting user as JSON; no header means anonymous.
jest.mock('../../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const ApiError = require('../../../src/utils/ApiError');
    const raw = req.headers['x-test-user'];
    if (!raw) return next(new ApiError(401, 'No token provided'));
    req.user = JSON.parse(raw);
    return next();
  },
}));
// Tag each permission gate with its scopes so the test can tell which routes are gated and by what.
jest.mock('../../../src/middleware/requirePermission', () => {
  const real = jest.requireActual('../../../src/middleware/requirePermission');
  return { requirePermission: (scope) => Object.assign(real.requirePermission(scope), { scopes: [].concat(scope) }) };
});

const express = require('express');
const request = require('supertest');
const rootRouter = require('../../../src/routes');
const { errorHandler, notFound } = require('../../../src/middleware/errorHandler');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../../src/utils/adminPermissions');

const OID = '64b000000000000000000001';

function mountPathOf(layer) {
  if (layer.regexp.fast_slash) return '';
  const m = layer.regexp.source.match(/^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) throw new Error(`cannot read mount path from ${layer.regexp}`);
  return m[1].replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/:p').replace(/\\\//g, '/');
}

// A gate registered inside a mounted router sees req.url / req.path without the mount prefix; keep that, so gates that look at
// req.path (money.routes.js, users.routes.js) behave exactly as in the real app.
function relative(fn, strip) {
  if (!strip) return fn;
  const wrapped = (req, res, next) => {
    const saved = req.url;
    req.url = saved.slice(strip.length) || '/';
    return fn(req, res, (err) => { req.url = saved; next(err); });
  };
  return Object.assign(wrapped, fn);
}

// Flatten a router tree into [{ method, path, gates[] }] keeping registration order.
function flatten(router, prefix = '', inherited = [], strip = '') {
  const out = [];
  const uses = [...inherited];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        const chain = layer.route.stack.map((l) => relative(l.handle, strip));
        out.push({ method, path: prefix + layer.route.path, gates: [...uses, ...chain.slice(0, -1)] });
      }
    } else if (layer.handle && layer.handle.stack) {
      const mount = mountPathOf(layer);
      out.push(...flatten(layer.handle, prefix + mount, uses, strip + mount));
    } else {
      uses.push(relative(layer.handle, strip));
    }
  }
  return out;
}

const ROUTES = flatten(rootRouter, '/api', [], '/api');

const app = express();
app.use(express.json());
for (const r of ROUTES) {
  app[r.method](r.path, ...r.gates, (req, res) => res.json({ success: true, reached: true }));
}
app.use(notFound);
app.use(errorHandler);

const concrete = (p) => p.replace(/:[A-Za-z]+/g, OID);
const as = (user) => (user ? { 'x-test-user': JSON.stringify(user) } : {});
// one shared listening server: a new one per request is slow and drops sockets under ~2,000 calls
const server = app.listen(0);
afterAll(() => new Promise((done) => server.close(done)));
const call = (r, user) => request(server)[r.method](concrete(r.path)).set(as(user)).send({});

const base = { id: OID, isSuspended: false, phoneVerified: true, onboardingComplete: true };
const USER = { ...base, role: 'USER' };
const PARTNER = { ...base, role: 'PARTNER', kycStatus: 'VERIFIED' };
const PARTNER_NO_KYC = { ...base, role: 'PARTNER', kycStatus: 'PENDING' };
const ADMIN = { ...base, role: 'ADMIN', staffRole: null };
const staff = (role) => ({ ...base, role: 'ADMIN', staffRole: role, adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE[role] });
const STAFF_ROLES = ['SUPPORT', 'CRM_MANAGER', 'FINANCE_STAFF', 'CONTENT_MANAGER'];

const adminRoutes = ROUTES.filter((r) => r.path.startsWith('/api/admin'));
const partnerRoutes = ROUTES.filter((r) => r.path.startsWith('/api/partner') && !r.path.startsWith('/api/partner/b2b'));
const userRoutes = ROUTES.filter((r) => r.path.startsWith('/api/user'));
const scopesOf = (r) => {
  // money.routes.js picks its gate per request, so it is described here by its rule instead of by a tag
  if (r.path.startsWith('/api/admin/money')) {
    const isRead = r.method === 'get' && !r.path.startsWith('/api/admin/money/export');
    return isRead ? ['FINANCE', 'FINANCE_VIEW'] : ['FINANCE'];
  }
  const tagged = r.gates.filter((g) => g.scopes);
  return tagged.length ? tagged[tagged.length - 1].scopes : null;
};

describe('route discovery', () => {
  test('finds the whole app, so the matrix below is not silently empty', () => {
    expect(ROUTES.length).toBeGreaterThan(300);
    expect(adminRoutes.length).toBeGreaterThan(150);
    expect(partnerRoutes.length).toBeGreaterThan(50);
    expect(userRoutes.length).toBeGreaterThan(30);
    expect(ROUTES.some((r) => r.path === '/api/admin/money/ledger/manual' && r.method === 'post')).toBe(true);
  });
});

describe('admin routes (including /api/admin/money)', () => {
  test.each(adminRoutes.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: anonymous 401, buyer 403, partner 403', async (_m, _p, r) => {
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, USER)).status).toBe(403);
    expect((await call(r, PARTNER)).status).toBe(403);
  });

  test.each(adminRoutes.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: an unscoped or super admin passes every gate', async (_m, _p, r) => {
    expect((await call(r, ADMIN)).status).toBe(200);
    expect((await call(r, { ...ADMIN, staffRole: 'SUPER_ADMIN', adminPermissions: [] })).status).toBe(200);
  });

  test.each(adminRoutes.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: each staff preset gets 200 only if it holds a required scope', async (_m, _p, r) => {
    const need = scopesOf(r);
    for (const role of STAFF_ROLES) {
      const allowed = !need || need.some((s) => DEFAULT_PERMISSIONS_BY_STAFF_ROLE[role].includes(s));
      const res = await call(r, staff(role));
      expect([role, res.status]).toEqual([role, allowed ? 200 : 403]);
    }
  });

  test('a staff admin holding no permissions at all is refused on every gated route and passes only the ungated reads', async () => {
    const none = { ...base, role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: [] };
    for (const r of adminRoutes) {
      const res = await call(r, none);
      expect([r.method, r.path, res.status]).toEqual([r.method, r.path, scopesOf(r) ? 403 : 200]);
    }
  });

  test('every state-changing admin route is behind a permission scope, except a reviewed list', async () => {
    const mutating = adminRoutes.filter((r) => r.method !== 'get' && !scopesOf(r)).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    // Open to any admin (even a limited staff role) on purpose or not yet reviewed. Keep this list SHORT: each line is a hole
    // a Support or Content admin can use. A new route that shows up here without a scope fails the test.
    expect(mutating).toEqual(KNOWN_UNSCOPED_MUTATIONS);
  });
});

// Reviewed 24 Oct: support-desk work any staff admin may do (inbox, read flags, review moderation, loan/video-tour status,
// dispute notes, B2B deal notes, advisor-referral revoke). Money-setting routes are NOT here: see the next test.
const KNOWN_UNSCOPED_MUTATIONS = [
  'PATCH /api/admin/loan/:id/status',
  'POST /api/admin/contact/templates', 'PATCH /api/admin/contact/templates/:id', 'DELETE /api/admin/contact/templates/:id',
  'POST /api/admin/contact/compose', 'PATCH /api/admin/contact/:id/read', 'PATCH /api/admin/contact/:id/status', 'POST /api/admin/contact/:id/reply',
  'PATCH /api/admin/nri-leads/:id/read', 'PATCH /api/admin/video-tours/:id', 'POST /api/admin/video-tours/:id/upload',
  'PATCH /api/admin/disputes/:id', 'PATCH /api/admin/reviews/:id/moderate', 'PATCH /api/admin/b2b/:id',
  'PATCH /api/admin/advisor-referrals/:id/revoke',
];

describe('commission terms are money: a Support or Content admin must not change them', () => {
  test.each([
    ['patch', '/api/admin/projects/:id/brokerage'],
    ['put', '/api/admin/leads/:id/commission'],
    ['post', '/api/admin/leads/:id/commission/prefill'],
  ])('%s %s needs COMMISSION', async (method, path) => {
    const r = ROUTES.find((x) => x.method === method && x.path === path);
    expect(scopesOf(r)).toEqual(['COMMISSION']);
    expect((await call(r, staff('SUPPORT'))).status).toBe(403);
    expect((await call(r, staff('CONTENT_MANAGER'))).status).toBe(403);
    expect((await call(r, staff('FINANCE_STAFF'))).status).toBe(200);
  });
});

describe('partner routes', () => {
  test.each(partnerRoutes.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: anonymous 401, buyer 403, partner and admin pass', async (_m, _p, r) => {
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, USER)).status).toBe(403);
    expect((await call(r, PARTNER)).status).toBe(200);
    expect((await call(r, ADMIN)).status).toBe(200);
  });

  test('a partner whose KYC is not verified is refused with KYC_REQUIRED exactly on the routes that need KYC', async () => {
    const kycRoutes = [];
    for (const r of partnerRoutes) {
      const res = await call(r, PARTNER_NO_KYC);
      if (res.status === 403) {
        expect(res.body.data.code).toBe('KYC_REQUIRED');
        kycRoutes.push(`${r.method.toUpperCase()} ${r.path}`);
      } else {
        expect(res.status).toBe(200);
      }
    }
    expect(kycRoutes).toContain('GET /api/partner/finance');
    expect(kycRoutes).toContain('PATCH /api/partner/bank-account');
    expect(kycRoutes).not.toContain('GET /api/partner/profile'); // profile and KYC submit must work before KYC
    expect(kycRoutes).not.toContain('POST /api/partner/kyc');
  });
});

describe('partner lead routes mounted under /api/leads/partner', () => {
  const rs = ROUTES.filter((r) => r.path.startsWith('/api/leads/partner'));
  test.each(rs.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: anonymous 401, buyer 403, unverified partner 403, verified partner 200', async (_m, _p, r) => {
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, USER)).status).toBe(403);
    expect((await call(r, PARTNER_NO_KYC)).status).toBe(403);
    expect((await call(r, PARTNER)).status).toBe(200);
  });
});

describe('buyer routes (/api/user)', () => {
  test.each(userRoutes.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: anonymous 401, any signed-in role passes the role gate', async (_m, _p, r) => {
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, USER)).status).toBe(200);
    expect((await call(r, PARTNER)).status).toBe(200);
  });

  test('routes that start money, files or tickets need a verified phone (PHONE_NOT_VERIFIED)', async () => {
    const unverified = { ...USER, phoneVerified: false };
    const gated = [];
    for (const r of userRoutes) {
      const res = await call(r, unverified);
      if (res.status === 403) { expect(res.body.data.code).toBe('PHONE_NOT_VERIFIED'); gated.push(`${r.method.toUpperCase()} ${r.path}`); }
    }
    expect(gated).toEqual(expect.arrayContaining(['POST /api/user/tickets', 'POST /api/user/loan', 'POST /api/user/documents', 'POST /api/user/favorites']));
  });
});

describe('escrow routes', () => {
  const rs = ROUTES.filter((r) => r.path.startsWith('/api/escrow') && r.path !== '/api/escrow/quote');
  test.each(rs.map((r) => [r.method.toUpperCase(), r.path, r]))('%s %s: anonymous 401, signed-in passes', async (_m, _p, r) => {
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, USER)).status).toBe(200);
  });
  test('paying needs a verified phone', async () => {
    const r = ROUTES.find((x) => x.path === '/api/escrow/create-order');
    const res = await call(r, { ...USER, phoneVerified: false });
    expect(res.status).toBe(403);
    expect(res.body.data.code).toBe('PHONE_NOT_VERIFIED');
  });
});

describe('what an anonymous caller can reach', () => {
  test('the anonymous state-changing routes are exactly the reviewed list', async () => {
    const open = [];
    for (const r of ROUTES.filter((x) => x.method !== 'get')) {
      const res = await call(r, null);
      if (res.status !== 401) open.push(`${r.method.toUpperCase()} ${r.path}`);
    }
    expect(open.sort()).toEqual(ANON_WRITES.sort());
  });
  test('no admin, user, partner or escrow GET is readable anonymously', async () => {
    for (const r of ROUTES.filter((x) => x.method === 'get' && /^\/api\/(admin|user|partner|escrow|notifications)/.test(x.path) && x.path !== '/api/escrow/quote' && !x.path.startsWith('/api/partner/b2b'))) {
      expect([r.path, (await call(r, null)).status]).toEqual([r.path, 401]);
    }
  });
});
// Public by design: sign-up and sign-in steps, the contact form, NRI enquiry, service request, and the "report an unauthorised
// listing" form. Each is rate limited and validated in its own handler (see the security pass in the report).
const ANON_WRITES = [
  'POST /api/auth/login/otp', 'POST /api/auth/login/verify', 'POST /api/auth/signup/otp', 'POST /api/auth/signup/verify',
  'POST /api/auth/sync', 'POST /api/contact/', 'POST /api/nri-leads/', 'POST /api/properties/:id/report-unauthorized',
  'POST /api/service-requests/',
];
