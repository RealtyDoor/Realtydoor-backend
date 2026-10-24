// BUG-014: a preflight from an origin that is not allowed answered 500.
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { buildCorsOptions } = require('../../src/lib/corsOptions');

const app = express();
app.use(cors(buildCorsOptions(['https://app.realtydoor.in'])));
app.get('/api/x', (req, res) => res.json({ ok: true }));

test('preflight from an unknown origin is not an error and carries no CORS permission', async () => {
  const res = await request(app).options('/api/x').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
  expect(res.status).toBeLessThan(500);
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

test('a plain request from an unknown origin is answered but without CORS permission', async () => {
  const res = await request(app).get('/api/x').set('Origin', 'https://evil.example');
  expect(res.status).toBe(200);
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

test('an allowed origin gets its permission, with credentials', async () => {
  const res = await request(app).get('/api/x').set('Origin', 'https://app.realtydoor.in');
  expect(res.headers['access-control-allow-origin']).toBe('https://app.realtydoor.in');
  expect(res.headers['access-control-allow-credentials']).toBe('true');
});

test('no Origin header (curl, mobile app, server to server) still works', async () => {
  expect((await request(app).get('/api/x')).status).toBe(200);
});
