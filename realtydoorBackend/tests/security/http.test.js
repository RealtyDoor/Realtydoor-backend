// Attacker's-eye checks against the real Express app: what an anonymous or hostile caller gets back. No database is touched,
// because every request here is refused before it reaches one.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URLS = 'https://www.realtydoor.com';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummysecret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
process.env.CLERK_WEBHOOK_SECRET = `whsec_${Buffer.from('test-secret-for-svix').toString('base64')}`;
process.env.WATI_WEBHOOK_TOKEN = 'wati-test-token';

const request = require('supertest');
const app = require('../../src/app');

describe('anonymous callers are refused on every private area', () => {
  const PRIVATE = [
    ['get', '/api/admin/leads'], ['get', '/api/admin/money/ledger'], ['post', '/api/admin/money/ledger/manual'],
    ['get', '/api/admin/properties'], ['patch', '/api/admin/leads/64b000000000000000000001/confirm'],
    ['get', '/api/user/leads'], ['get', '/api/user/ratings'], ['post', '/api/user/leads/64b000000000000000000001/cancel'],
    ['get', '/api/partner/leads'], ['get', '/api/partner/support-tickets'], ['post', '/api/partner/support-tickets/64b000000000000000000001/reply'],
    ['get', '/api/escrow/64b000000000000000000001'], ['get', '/api/escrow/64b000000000000000000001/receipt'],
    ['get', '/api/escrow/64b000000000000000000001/fee-invoice'], ['post', '/api/escrow/create-order'], ['post', '/api/escrow/verify-payment'],
    ['get', '/api/locality-insights/options?city=Bangalore'], ['post', '/api/locality-insights/suggest'], ['get', '/api/locality-insights/suggestions'],
    ['get', '/api/notifications'], ['post', '/api/leads/partner'], ['get', '/api/partner/b2b/deals'],
  ];
  test.each(PRIVATE)('%s %s -> 401', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('a forged or garbage bearer token is refused, not accepted and not a 500', async () => {
    for (const token of ['garbage', 'a.b.c', '', 'null', 'x'.repeat(5000)]) {
      const res = await request(app).get('/api/user/leads').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  test('the dev-bypass header does nothing without the server-side key', async () => {
    const res = await request(app).get('/api/admin/leads').set('x-dev-api-key', 'anything').set('x-dev-user-email', 'admin@realtydoor.com');
    expect(res.status).toBe(401);
  });
});

describe('hostile request bodies', () => {
  test('malformed JSON is a clean 400, with no stack or parser internals', async () => {
    const res = await request(app).post('/api/contact').set('Content-Type', 'application/json').send('{"a": ');
    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+\.|node_modules|Unexpected|position/);
  });

  test('an oversized JSON body is a 413, not processed', async () => {
    const res = await request(app).post('/api/contact').set('Content-Type', 'application/json').send(JSON.stringify({ message: 'x'.repeat(3 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.data.code).toBe('BODY_TOO_LARGE');
  });

  test('a malformed ObjectId in the path is a 400, not a 500', async () => {
    const res = await request(app).get('/api/escrow/not-an-id');
    expect([400, 401]).toContain(res.status); // refused before or after auth, never a crash
  });
});

describe('browser-facing protections', () => {
  test('security headers are on API responses and the framework is not advertised', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  test('a page from another website cannot make credentialed calls: no CORS allow header for an unlisted origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('our own site is allowed, with credentials', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://www.realtydoor.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://www.realtydoor.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('an unknown route is a plain 404 with no stack trace', async () => {
    const res = await request(app).get('/api/this-does-not-exist');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|at \w+\./);
  });
});

describe('webhooks only accept signed calls', () => {
  test('Razorpay: no signature and a wrong signature are both refused', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const none = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').send(body);
    expect(none.status).toBe(400);
    const wrong = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'deadbeef').send(body);
    expect(wrong.status).toBe(400);
  });

  test('Clerk: missing signature headers and a forged signature are both refused', async () => {
    const missing = await request(app).post('/api/webhooks/clerk').set('Content-Type', 'application/json').send('{"type":"user.created"}');
    expect(missing.status).toBe(400);
    const forged = await request(app).post('/api/webhooks/clerk').set('Content-Type', 'application/json')
      .set('svix-id', 'msg_1').set('svix-timestamp', String(Math.floor(Date.now() / 1000))).set('svix-signature', 'v1,Zm9yZ2Vk')
      .send('{"type":"user.created","data":{"id":"user_x"}}');
    expect(forged.status).toBe(400);
  });

  test('WATI: no token and a wrong token are refused (header or query string)', async () => {
    const send = () => request(app).post('/api/webhooks/wati').set('Content-Type', 'application/json').send('{"waId":"919000000000","text":"yes"}');
    expect((await send()).status).toBe(401);
    expect((await send().set('x-wati-token', 'wrong')).status).toBe(401);
    expect((await request(app).post('/api/webhooks/wati?token=wrong').set('Content-Type', 'application/json').send('{}')).status).toBe(401);
  });

  test('a webhook with a body that is not JSON is a 400', async () => {
    const res = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').send('not json');
    expect(res.status).toBe(400);
  });
});

describe('the public price check cannot be abused', () => {
  test.each([['abc'], ['-5'], ['0'], ['1e300'], ['Infinity'], [''], ['999999999999']])('amount=%s is a 400', async (amount) => {
    const res = await request(app).get(`/api/escrow/quote?amount=${encodeURIComponent(amount)}`);
    expect(res.status).toBe(400);
  });

  test('two amounts at once (parameter pollution) do not crash it', async () => {
    const res = await request(app).get('/api/escrow/quote?amount=100&amount=200');
    expect([200, 400]).toContain(res.status);
  });
});
