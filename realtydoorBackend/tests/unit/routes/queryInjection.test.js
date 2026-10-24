// Attacker probe: Express turns ?status[not]=x into an object. If a controller hands it to Prisma unchecked, the caller picks the
// query operator (for example to read rows the endpoint filters out). Every GET route is called, with real controllers and services,
// with a marker object in every common parameter; a database call that receives the marker is a hole. The database is a recorder.
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
const calls = [];
const handler = (path) => new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined;
    return handler([...path, String(prop)]);
  },
  apply: (_t, _this, args) => {
    calls.push({ path: path.join('.'), args });
    const last = path[path.length - 1];
    if (/^(findMany|aggregate|groupBy)$/.test(last)) return Promise.resolve([]);
    if (last === 'count') return Promise.resolve(0);
    if (path[0] === '$transaction') return Promise.resolve([]);
    return Promise.resolve(null);
  },
});
jest.mock('../../../src/lib/prisma', () => handler([]));
jest.mock('../../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { id: '64b000000000000000000001', role: 'ADMIN', staffRole: null, phoneVerified: true, onboardingComplete: true, kycStatus: 'VERIFIED' }; next(); },
}));
jest.mock('../../../src/lib/cache', () => ({ cacheGet: async () => null, cacheSet: async () => {}, cacheDel: async () => {}, cacheDelPattern: async () => {}, withCache: async (k, t, fn) => fn() }));
jest.mock('../../../src/middleware/auditAction', () => ({ auditAction: () => (req, res, next) => next() }));

const request = require('supertest');
const app = require('../../../src/app');

const PARAMS = ['status', 'type', 'city', 'locality', 'q', 'search', 'id', 'partnerId', 'userId', 'leadId', 'propertyId', 'projectId', 'role', 'kind',
  'category', 'slug', 'sort', 'sortBy', 'from', 'to', 'month', 'bhk', 'minPrice', 'maxPrice', 'phone', 'email', 'refCode', 'key', 'escrowId', 'sellerType'];
const OID = '64b000000000000000000001';

// Every GET route from the real router tree.
const rootRouter = require('../../../src/routes');
function mountPathOf(layer) {
  if (layer.regexp.fast_slash) return '';
  const m = layer.regexp.source.match(/^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m[1].replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/:p').replace(/\\\//g, '/');
}
function gets(router, prefix = '') {
  const out = [];
  for (const layer of router.stack) {
    if (layer.route && layer.route.methods.get) out.push(prefix + layer.route.path);
    else if (layer.handle && layer.handle.stack) out.push(...gets(layer.handle, prefix + mountPathOf(layer)));
  }
  return out;
}
const GET_PATHS = [...new Set(gets(rootRouter, '/api'))].filter((p) => !/export|pdf|receipt|invoice|brochure|download|\*/.test(p));

test('the route walk found the API', () => expect(GET_PATHS.length).toBeGreaterThan(150));

test('no GET route passes a caller-supplied operator object into a database query', async () => {
  const offenders = new Set();
  for (const p of GET_PATHS) {
    calls.length = 0;
    const url = p.replace(/:[A-Za-z]+/g, OID);
    const qs = PARAMS.map((k) => `${k}[$marker]=1`).join('&');
    await request(app).get(`${url}?${qs}`).timeout({ response: 4000, deadline: 6000 }).catch(() => {});
    for (const c of calls) if (JSON.stringify(c.args).includes('$marker')) offenders.add(`${p} -> ${c.path}`);
  }
  expect([...offenders].sort()).toEqual([]);
}, 120000);

// Odd but legal query strings must be answered with a normal response (2xx or 4xx), never a server error: repeated parameters (an
// array), very long values, regex and path characters, huge or negative numbers.
const ODD = {
  repeated: PARAMS.map((k) => `${k}=a&${k}=b`).join('&'),
  long: PARAMS.map((k) => `${k}=${'x'.repeat(400)}`).join('&'), // stays under Node's 16 KB header limit
  specials: PARAMS.map((k) => `${k}=${encodeURIComponent('.*(?:a+)+$\\..\\/../%$"\'{}<script>')}`).join('&'),
  numbers: PARAMS.map((k) => `${k}=${['-1', '99999999999999999999', '1e309', 'NaN', '0'][PARAMS.indexOf(k) % 5]}`).join('&'),
  paging: 'page=-5&limit=100000000&skip=-1&take=999999',
};

// Routes that already fail with no query at all are the recorder database's doing (it returns empty results where a report expects
// totals), not the query string's; they are left out so only what the query string causes is reported.
async function baseline() {
  const failing = new Set();
  for (const p of GET_PATHS) {
    const res = await request(app).get(p.replace(/:[A-Za-z]+/g, OID)).timeout({ response: 4000, deadline: 6000 }).catch(() => ({ status: 500 }));
    if (res.status >= 500) failing.add(p);
  }
  return failing;
}

test.each(Object.entries(ODD))('no GET route answers a server error to %s parameters', async (_name, qs) => {
  const skip = await baseline();
  const bad = [];
  for (const p of GET_PATHS.filter((x) => !skip.has(x))) {
    const url = p.replace(/:[A-Za-z]+/g, OID);
    const res = await request(app).get(`${url}?${qs}`).timeout({ response: 4000, deadline: 6000 }).catch((e) => ({ status: `error:${e.code || e.message}` }));
    if (typeof res.status !== 'number' || res.status >= 500) bad.push(`${p} -> ${res.status}`);
  }
  expect(bad.sort()).toEqual([]);
}, 180000);
