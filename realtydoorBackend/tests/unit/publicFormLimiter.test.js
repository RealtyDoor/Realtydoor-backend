// 29 Oct 2026: found live that the public forms (contact, NRI, service request, report a listing) accepted 12 submissions in a row from one address.
// They now have their own hourly limit per client address, and a hidden "website" field that real visitors never fill in.
const express = require('express');
const request = require('supertest');
const { makePublicFormLimiter } = require('../../src/middleware/rateLimiter');
const honeypot = require('../../src/middleware/honeypot');

const appWith = (limit) => {
  const app = express();
  app.use(express.json());
  app.post('/form', limit, honeypot, (req, res) => res.status(201).json({ saved: true }));
  return app;
};

test('the 11th submission within the hour from one address is refused with RATE_LIMITED', async () => {
  const app = appWith(makePublicFormLimiter({ max: 10, enabledInTest: true }));
  for (let i = 0; i < 10; i += 1) expect((await request(app).post('/form').send({ a: i })).status).toBe(201);
  const r = await request(app).post('/form').send({ a: 11 });
  expect(r.status).toBe(429);
  expect(r.body.data.code).toBe('RATE_LIMITED');
});

test('a filled hidden field is a bot: it gets a normal-looking success and nothing is saved', async () => {
  const app = appWith(makePublicFormLimiter({ max: 10, enabledInTest: true }));
  const r = await request(app).post('/form').send({ name: 'Bot', website: 'http://spam.example' });
  expect(r.status).toBe(201);
  expect(r.body.saved).toBeUndefined();
  expect(r.body.success).toBe(true);
});

test('an empty or missing hidden field passes through to the real handler', async () => {
  const app = appWith(makePublicFormLimiter({ max: 10, enabledInTest: true }));
  expect((await request(app).post('/form').send({ website: '' })).body.saved).toBe(true);
  expect((await request(app).post('/form').send({})).body.saved).toBe(true);
});

test('the four public form routes use both guards', () => {
  const fs = require('fs');
  for (const f of ['contact/contact.routes.js', 'nriLeads/nriLeads.routes.js', 'serviceRequests/serviceRequests.routes.js']) {
    const src = fs.readFileSync(require('path').join(__dirname, '../../src/modules', f), 'utf8');
    expect(src).toMatch(/publicFormLimiter/);
    expect(src).toMatch(/honeypot/);
  }
  const props = fs.readFileSync(require('path').join(__dirname, '../../src/modules/properties/properties.routes.js'), 'utf8');
  expect(props).toMatch(/report-unauthorized', publicFormLimiter, honeypot/);
});
