// BUG-021 (follow-up): the tunnel and any uptime check could not ask the API "are you up" because /api/health was a 404, so a
// 502 could not be told apart from a real outage. Both /health and /api/health answer without touching the database or sign-in.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';
const request = require('supertest');
const app = require('../../src/app');

test.each(['/health', '/api/health'])('GET %s is 200 {status: ok} for anyone, with no sign-in', async (path) => {
  const res = await request(app).get(path);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
  expect(typeof res.body.ts).toBe('number');
});

test('the health answer carries no internals (versions, env, database state)', async () => {
  const res = await request(app).get('/api/health');
  expect(Object.keys(res.body).sort()).toEqual(['status', 'ts']);
});

test('only GET: a POST to /api/health is not a health check', async () => {
  const res = await request(app).post('/api/health').send({});
  expect([401, 404]).toContain(res.status);
});
