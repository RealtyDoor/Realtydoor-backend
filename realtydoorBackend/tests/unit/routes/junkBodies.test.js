// Audit Nov 2026 (E2, controller wiring). Every change route (POST, PATCH, PUT, DELETE) except file uploads and webhooks is called with bodies
// that no honest client sends: empty, wrong types, huge text, markup, nested objects. A request the validators should refuse must get a
// 4xx, never a 5xx (a crash would mean a field reached the logic unchecked). The database is a recorder that answers "nothing found".
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
const handler = (path) => new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'then' ? undefined : handler([...path, String(prop)])),
  apply: (_t, _this, args) => {
    const last = path[path.length - 1];
    if (/^(findMany|aggregate|groupBy)$/.test(last)) return Promise.resolve([]);
    if (last === 'count') return Promise.resolve(0);
    if (/^(deleteMany|updateMany)$/.test(last)) return Promise.resolve({ count: 0 });
    if (path[0] === '$transaction') return Promise.resolve([]);
    return Promise.resolve(null);
  },
});
jest.mock('../../../src/lib/prisma', () => handler([]));
jest.mock('../../../src/middleware/auth', () => {
  const user = (req, res, next) => { req.user = { id: '64b000000000000000000001', role: global.__role || 'ADMIN', staffRole: null, phoneVerified: true, onboardingComplete: true, kycStatus: 'VERIFIED', adminPermissions: null }; next(); };
  return { authenticate: user, optionalAuthenticate: (req, res, next) => next() };
});
jest.mock('../../../src/lib/cache', () => ({ cacheGet: async () => null, cacheSet: async () => {}, cacheDel: async () => {}, cacheDelPattern: async () => {}, withCache: async (k, t, fn) => fn() }));
jest.mock('../../../src/middleware/auditAction', () => ({ auditAction: () => (req, res, next) => next() }));
jest.mock('../../../src/lib/razorpay', () => ({
  razorpay: { orders: { fetch: async () => { throw new Error('offline'); }, fetchPayments: async () => ({ items: [] }) }, payments: { fetch: async () => { throw new Error('offline'); } } },
  createOrder: async () => { throw new Error('offline'); }, createEscrowOrder: async () => { throw new Error('offline'); }, refundPayment: async () => { throw new Error('offline'); },
  verifyPaymentSignature: () => false, verifyWebhookSignature: () => false,
}));
jest.mock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => ({ verifyToken: async () => { throw new Error('bad'); }, users: { getUser: async () => ({}) }, sessions: {} }) }));

const request = require('supertest');
const app = require('../../../src/app');
const server = app.listen(0);
afterAll(() => new Promise((done) => server.close(done)));

const rootRouter = require('../../../src/routes');
function mountPathOf(layer) {
  if (layer.regexp.fast_slash) return '';
  const m = layer.regexp.source.match(/^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m[1].replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/:p').replace(/\\\//g, '/');
}
function changes(router, prefix = '') {
  const out = [];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) if (m !== 'get') out.push([m, prefix + layer.route.path]);
    } else if (layer.handle && layer.handle.stack) out.push(...changes(layer.handle, prefix + mountPathOf(layer)));
  }
  return out;
}
const OID = '64b000000000000000000001';
const ROUTES = [...new Map(changes(rootRouter, '/api')
  .filter(([, p]) => !/upload|document|photo|media|image|brochure|webhook|video|logo|avatar|import/i.test(p))
  .map(([m, p]) => [`${m} ${p}`, [m, p.replace(/:[A-Za-z]+/g, OID)]])).values()];

const BODIES = [
  {}, { a: 1 }, [], 'text', null,
  { name: 'x'.repeat(5000), phone: 'x'.repeat(5000), email: 'x'.repeat(5000), amount: 'x'.repeat(5000) },
  { amount: -1, leadId: 123, phone: { $gt: '' }, email: ['a'], name: { a: 1 }, reason: 5, status: {}, note: [] },
  { name: '<script>alert(1)</script>', phone: '+91\u0000', amount: 1e309, reason: '\ud800' },
];

test('the walk found the routes', () => expect(ROUTES.length).toBeGreaterThan(200));

test.each(['USER', 'ADMIN', 'PARTNER'])('as %s: no junk body makes a change route crash (5xx)', async (role) => {
  global.__role = role;
  const bad = new Set();
  for (const [method, path] of ROUTES) {
    for (const body of BODIES) {
      const res = await request(server)[method](path).set('Content-Type', 'application/json').send(typeof body === 'string' ? JSON.stringify(body) : body === null ? 'null' : body);
      if (res.status >= 500 && ![502, 503].includes(res.status)) bad.add(`${method.toUpperCase()} ${path} -> ${res.status} ${(res.body && res.body.message) || ''}`.slice(0, 160));
    }
  }
  expect([...bad]).toEqual([]);
}, 120000);
