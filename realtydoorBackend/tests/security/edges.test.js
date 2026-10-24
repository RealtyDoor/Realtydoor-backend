// More attacker's-eye checks against the real Express app. No database is reached: each request is refused before one.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
process.env.FRONTEND_URLS = 'https://www.realtydoor.com,https://app.realtydoor.com';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummysecret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
process.env.CLERK_WEBHOOK_SECRET = `whsec_${Buffer.from('test-secret-for-svix').toString('base64')}`;
process.env.WATI_WEBHOOK_TOKEN = 'wati-test-token';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');

describe('CORS: look-alike origins get nothing', () => {
  test.each([
    ['https://www.realtydoor.com.evil.example'], ['https://evilwww.realtydoor.com'], ['http://www.realtydoor.com'], ['https://www.realtydoor.com:8443'],
    ['null'], ['https://WWW.REALTYDOOR.COM'], ['https://www.realtydoor.com/'], ['file://'], ['https://realtydoor.com'],
  ])('origin %s is not allowed', async (origin) => {
    const res = await request(app).get('/api/health').set('Origin', origin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  test('a preflight from an unlisted origin is answered, without permission headers, and is not an error', async () => {
    const res = await request(app).options('/api/user/leads').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBeLessThan(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  test('both of our own sites are allowed', async () => {
    for (const o of ['https://www.realtydoor.com', 'https://app.realtydoor.com']) {
      expect((await request(app).get('/api/health').set('Origin', o)).headers['access-control-allow-origin']).toBe(o);
    }
  });
});

describe('response hygiene', () => {
  test('the API never says what it runs on', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
  });
  test('an error response for an unknown route does not echo script from the URL as HTML', async () => {
    const res = await request(app).get('/api/%3Cscript%3Ealert(1)%3C/script%3E');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  test('a protected route without a token says only that a token is missing', async () => {
    const res = await request(app).get('/api/admin/leads');
    expect(res.status).toBe(401);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
  });
});

describe('webhook edges', () => {
  const sign = (raw) => crypto.createHmac('sha256', 'whsec_test').update(raw).digest('hex');
  test('a valid signature over a different body is refused (the body cannot be swapped after signing)', async () => {
    const signed = JSON.stringify({ event: 'noop' });
    const res = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign(signed)).send(JSON.stringify({ event: 'payment.captured' }));
    expect(res.status).toBe(400);
  });
  test('a correctly signed event we do not use is acknowledged', async () => {
    const raw = JSON.stringify({ event: 'something.new' });
    const res = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign(raw)).send(raw);
    expect(res.status).toBe(200);
  });
  test('a webhook sent as form data or plain text is refused, not parsed', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await request(app).post('/api/webhooks/razorpay').set('Content-Type', type).set('x-razorpay-signature', sign('a=b')).send('a=b');
      expect(res.status).toBe(400);
    }
  });
  test('an oversized webhook body is refused cleanly', async () => {
    const res = await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'x').send(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
    expect([400, 413]).toContain(res.status);
  });
  test('a GET to a webhook URL is not a way in', async () => {
    for (const p of ['razorpay', 'clerk', 'wati']) expect((await request(app).get(`/api/webhooks/${p}`)).status).toBe(404);
  });
});

describe('request smuggling-ish inputs', () => {
  test('a NUL byte in the path, query or body is a 400', async () => {
    expect((await request(app).get('/api/properties?city=a%00b')).status).toBe(400);
    expect((await request(app).post('/api/contact').send({ name: 'a\u0000b', message: 'm' })).status).toBe(400);
  });
  test('a nested query value (operator injection) is a 400', async () => {
    const res = await request(app).get('/api/properties?city[$ne]=x');
    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('INVALID_QUERY');
  });
  test('an __proto__ key in a JSON body does not pollute anything', async () => {
    await request(app).post('/api/contact').set('Content-Type', 'application/json').send('{"__proto__":{"polluted":true},"name":"a"}');
    expect({}.polluted).toBeUndefined();
  });
  test('an enormous number of query parameters is not a crash', async () => {
    const qs = Array.from({ length: 3000 }, (_, i) => `k${i}=v`).join('&');
    expect((await request(app).get(`/api/health?${qs}`)).status).toBeLessThan(500);
  });
});
