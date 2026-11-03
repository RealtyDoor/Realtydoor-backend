// Sales-only (BDE) lock. Same harness as roleMatrix.test.js: walks every route the real app mounts (from src/routes/index.js, so a new route is picked up
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
const { isSalesOnly } = require('../../../src/lib/leadSales');
const { restrictSalesOnly } = require('../../../src/middleware/salesOnly');

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
const BDE = { ...base, role: 'ADMIN', staffRole: 'BDE', adminPermissions: ['SALES'] };
const BDE_DEFAULT = { ...base, role: 'ADMIN', staffRole: 'BDE', adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE.BDE };
const SALES_PLUS_TICKETS = { ...base, role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: ['SALES', 'TICKETS'] };
const MANAGER = { ...base, role: 'ADMIN', staffRole: 'CRM_MANAGER', adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE.CRM_MANAGER };
const OWNER = { ...base, role: 'ADMIN', staffRole: null };
const SUPER = { ...base, role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: [] };

const adminRoutes = ROUTES.filter((r) => r.path.startsWith('/api/admin'));
const key = (r) => `${r.method.toUpperCase()} ${r.path}`;
const LOCK_MESSAGE = 'Not available for your role';

// The only admin routes a sales-only BDE may use: the lead routes that are themselves scoped to the leads they own.
const ALLOWED = [
  'GET /api/admin/leads',
  'GET /api/admin/leads/sales-summary',
  'GET /api/admin/leads/owners',
  'GET /api/admin/leads/:id',
  'GET /api/admin/leads/:id/notes',
  'POST /api/admin/leads/:id/notes',
  'PATCH /api/admin/leads/:id/sales',
].sort();

describe('isSalesOnly', () => {
  test.each([
    [BDE, true], [BDE_DEFAULT, true],
    [SALES_PLUS_TICKETS, false], [MANAGER, false], [OWNER, false], [SUPER, false],
    [{ ...base, role: 'ADMIN', staffRole: 'BDE', adminPermissions: [] }, false], // no permissions at all is not "sales only"
    [{ ...base, role: 'ADMIN', staffRole: 'BDE' }, false],
    [{ ...base, role: 'ADMIN', staffRole: null, adminPermissions: ['SALES'] }, false], // an older admin with no staff role keeps full access
    [{ ...base, role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: ['SALES'] }, false],
    [{ ...base, role: 'ADMIN', staffRole: 'BDE', adminPermissions: ['SALES', 'LEADS'] }, false],
    [null, false], [undefined, false],
  ])('%j -> %s', (user, expected) => expect(isSalesOnly(user)).toBe(expected));

  test('the BDE preset is sales only, so choosing the BDE role in the team form locks it', () => {
    expect(DEFAULT_PERMISSIONS_BY_STAFF_ROLE.BDE).toEqual(['SALES']);
    expect(isSalesOnly(BDE_DEFAULT)).toBe(true);
  });
});

describe('the sales-only lock, on every real admin route', () => {
  test('route discovery finds the routes the lock must cover', () => {
    expect(adminRoutes.length).toBeGreaterThan(150);
    for (const k of ALLOWED) expect(adminRoutes.map(key)).toContain(k);
  });

  test('a BDE gets 200 on exactly the lead routes and 403 on every other admin route', async () => {
    const open = [];
    const shut = [];
    for (const r of adminRoutes) {
      const res = await call(r, BDE);
      if (res.status === 200) open.push(key(r));
      else { expect([key(r), res.status]).toEqual([key(r), 403]); shut.push(key(r)); }
    }
    expect(open.sort()).toEqual(ALLOWED);
    expect(shut.length).toBe(adminRoutes.length - ALLOWED.length);
  });

  test('the same holds with the exact permissions the BDE role preset hands out', async () => {
    const open = [];
    for (const r of adminRoutes) if ((await call(r, BDE_DEFAULT)).status === 200) open.push(key(r));
    expect(open.sort()).toEqual(ALLOWED);
  });

  test('the dangerous reads a BDE must not have are shut: users, escrow, money, partners, every other lead path', async () => {
    const find = (m, p) => adminRoutes.find((r) => r.method === m && r.path === p);
    for (const [m, p] of [
      ['get', '/api/admin/users'], ['get', '/api/admin/escrow'], ['get', '/api/admin/revenue'], ['get', '/api/admin/partners'],
      ['get', '/api/admin/leads/export'], ['get', '/api/admin/leads/:id/commission'], ['post', '/api/admin/leads'],
      ['patch', '/api/admin/leads/:id/assign'], ['patch', '/api/admin/leads/:id/note'], ['get', '/api/admin/leads/monitor'],
    ]) {
      const r = find(m, p);
      if (!r) continue; // a route that does not exist in this build cannot leak
      const res = await call(r, BDE);
      expect([key(r), res.status]).toEqual([key(r), 403]);
    }
  });

  // The harness only runs gates on routes that exist, so odd paths are checked against the middleware itself.
  test.each([
    ['DELETE', `/leads/${OID}/notes`], ['PUT', `/leads/${OID}/sales`], ['GET', `/leads/${OID}/sales`], ['PATCH', `/leads/${OID}/notes`],
    ['GET', `/leads/${OID}/notes/extra`], ['GET', '/leads/not-an-id'], ['GET', '/leads/../users'], ['GET', `/leads/${OID}/commission`],
    ['POST', '/leads'], ['GET', '/leads/export'], ['GET', '/users'], ['GET', '/'], ['GET', `/leads/${OID}0`], ['GET', `/leads/${OID.slice(1)}`],
  ])('the lock refuses %s %s', (method, path) => {
    let err; restrictSalesOnly({ user: BDE, method, path }, {}, (e) => { err = e; });
    expect(err).toMatchObject({ statusCode: 403, message: LOCK_MESSAGE });
  });

  test.each([
    ['GET', '/leads'], ['GET', '/leads/'], ['GET', '/leads/sales-summary'], ['GET', '/leads/owners'], ['GET', `/leads/${OID}`],
    ['GET', `/leads/${OID}/notes`], ['POST', `/leads/${OID}/notes`], ['PATCH', `/leads/${OID}/sales`],
  ])('the lock lets %s %s through', (method, path) => {
    let err = 'not called'; restrictSalesOnly({ user: BDE, method, path }, {}, (e) => { err = e; });
    expect(err).toBeUndefined();
  });

  test('anyone who is not sales-only passes the lock untouched, on any path', () => {
    for (const user of [MANAGER, OWNER, SUPER, SALES_PLUS_TICKETS, undefined]) {
      let err = 'not called'; restrictSalesOnly({ user, method: 'DELETE', path: '/users/1' }, {}, (e) => { err = e; });
      expect(err).toBeUndefined();
    }
  });

  test('anonymous callers and non-admins are refused before the lock is even asked', async () => {
    const r = adminRoutes.find((x) => key(x) === 'GET /api/admin/leads');
    expect((await call(r, null)).status).toBe(401);
    expect((await call(r, { ...base, role: 'PARTNER', kycStatus: 'VERIFIED' })).status).toBe(403);
  });
});

describe('everyone else is not newly blocked', () => {
  test.each([['manager (CRM)', MANAGER], ['owner with no staff role', OWNER], ['super admin', SUPER], ['SALES plus TICKETS', SALES_PLUS_TICKETS]])(
    '%s never meets the sales-only lock message',
    async (_n, user) => {
      for (const r of adminRoutes) {
        const res = await call(r, user);
        expect([key(r), res.body?.message === LOCK_MESSAGE]).toEqual([key(r), false]);
      }
    },
  );

  test('a manager still reaches the whole lead area, including export and assign', async () => {
    for (const k of [...ALLOWED, 'GET /api/admin/leads/export', 'PATCH /api/admin/leads/:id/assign']) {
      const r = adminRoutes.find((x) => key(x) === k);
      expect([k, (await call(r, MANAGER)).status]).toEqual([k, 200]);
    }
  });

  test('SALES plus TICKETS keeps the ticket routes and ungated reads that BDE alone loses', async () => {
    for (const k of ['PATCH /api/admin/tickets/:id', 'GET /api/admin/users']) {
      const r = adminRoutes.find((x) => key(x) === k);
      if (!r) continue;
      expect([k, (await call(r, SALES_PLUS_TICKETS)).status]).toEqual([k, 200]);
      expect([k, (await call(r, BDE)).status]).toEqual([k, 403]);
    }
  });
});
