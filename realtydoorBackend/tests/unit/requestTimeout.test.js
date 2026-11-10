// 7 Nov 2026 (load test): one stuck database call held a request for 108 seconds before a 500. Reads now stop waiting after
// REQUEST_TIMEOUT_MS (default 30 s) and answer 503 "try again" with Retry-After. WRITES are never cut (they can still complete on the
// server after a timeout, so the user would be told "failed" about something that worked: payments, refunds, assignments). Exports,
// reports and PDFs are slow on purpose and are left alone too.
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS } = require('../../src/middleware/requestTimeout');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function appWith(ms) {
  const app = express();
  app.use(express.json());
  app.use('/api', requestTimeout(ms));
  app.get('/api/slow', async (req, res) => { await sleep(300); try { res.json({ ok: true }); } catch { /* late answer after the 503 */ } });
  app.get('/api/fast', (req, res) => res.json({ ok: true }));
  app.post('/api/slow-write', async (req, res) => { await sleep(300); res.json({ done: true }); });
  app.put('/api/slow-put', async (req, res) => { await sleep(300); res.json({ done: true }); });
  app.get('/api/admin/leads/export', async (req, res) => { await sleep(300); res.json({ rows: 1 }); });
  app.get('/api/locality-insights/report', async (req, res) => { await sleep(300); res.json({ pdf: true }); });
  app.get('/api/partner/statements/abc/pdf', async (req, res) => { await sleep(300); res.json({ pdf: true }); });
  return app;
}

describe('a slow read', () => {
  test('answers 503 REQUEST_TIMEOUT with Retry-After once the limit passes', async () => {
    const res = await request(appWith(60)).get('/api/slow');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toEqual({ success: false, message: 'The server is taking too long to answer. Please try again in a moment.', data: { code: 'REQUEST_TIMEOUT' } });
  });
  test('a fast read is untouched', async () => {
    const res = await request(appWith(60)).get('/api/fast');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  test('the handler finishing late does not crash anything, and the next request works', async () => {
    const app = appWith(50);
    expect((await request(app).get('/api/slow')).status).toBe(503);
    await sleep(350); // the handler now tries to answer a request that already got its 503
    expect((await request(app).get('/api/fast')).status).toBe(200);
  });
});

describe('what is never cut', () => {
  test.each([['post', '/api/slow-write'], ['put', '/api/slow-put']])('a slow %s (a write) is allowed to finish', async (verb, url) => {
    const res = await request(appWith(60))[verb](url).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true });
  });
  test.each(['/api/admin/leads/export', '/api/locality-insights/report', '/api/partner/statements/abc/pdf'])('a slow export, report or PDF (%s) is allowed to finish', async (url) => {
    expect((await request(appWith(60)).get(url)).status).toBe(200);
  });
});

describe('the limit itself', () => {
  test('defaults to 30 seconds', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30000);
  });
  test('REQUEST_TIMEOUT_MS overrides it; junk, zero and negative values fall back to 30 seconds', () => {
    const { resolveTimeoutMs } = require('../../src/middleware/requestTimeout');
    expect(resolveTimeoutMs({ REQUEST_TIMEOUT_MS: '12000' })).toBe(12000);
    for (const bad of ['', 'abc', '0', '-5', undefined, 'NaN']) expect(resolveTimeoutMs({ REQUEST_TIMEOUT_MS: bad })).toBe(30000);
  });
});

describe('wiring in app.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/app.js'), 'utf8');
  test('the limit is mounted on /api before the routes', () => {
    const at = src.indexOf('requestTimeout()');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf("routes);"));
  });
  test('the webhooks (mounted before the JSON parser) are not under it', () => {
    expect(src.indexOf("app.use('/api/webhooks'")).toBeLessThan(src.indexOf('requestTimeout()'));
  });
});
