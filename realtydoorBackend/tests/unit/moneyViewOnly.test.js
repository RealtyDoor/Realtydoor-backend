// CRM_MANAGER gets FINANCE_VIEW: it can read a deal's money to answer a buyer or partner, but cannot change, invoice or download it.
jest.mock('../../src/modules/money/money.controller', () => new Proxy({}, { get: () => (req, res) => res.status(200).json({ ok: true, via: req.method + ' ' + req.path }) }));

const express = require('express');
const request = require('supertest');
const router = require('../../src/modules/money/money.routes');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../src/utils/adminPermissions');

const as = (user) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/money', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  return app;
};
const staff = (staffRole) => ({ role: 'ADMIN', staffRole, adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE[staffRole] });
const OID = '6adad1edef599c346aebe2a4';

describe('CRM manager: read money, change nothing', () => {
  const crm = as(staff('CRM_MANAGER'));
  test.each([
    '/money/deals/' + OID, '/money/ledger', '/money/payables', '/money/profit', '/money/reconcile', '/money/audit-chain', '/money/tds', '/money/tds/summary', '/money/tax-invoices',
  ])('may read %s', async (url) => {
    expect((await request(crm).get(url)).status).toBe(200);
  });
  test('may not download the accountant export', async () => {
    const r = await request(crm).get('/money/export?kind=ledger&month=2026-10');
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('Missing the FINANCE permission');
  });
  test.each([
    ['post', '/money/ledger/manual'], ['post', '/money/tds/deposit'], ['post', '/money/tds/return'], ['post', '/money/tds/form16a'],
    ['post', '/money/tax-invoices/' + OID + '/accept'], ['post', '/money/tax-invoices/' + OID + '/reject'], ['post', '/money/tax-invoices/' + OID + '/match'],
  ])('may not %s %s', async (verb, url) => {
    expect((await request(crm)[verb](url).send({})).status).toBe(403);
  });
});

describe('everyone else', () => {
  test('Finance staff and the owner can do all of it', async () => {
    for (const user of [staff('FINANCE_STAFF'), { role: 'ADMIN', staffRole: null }, staff('SUPER_ADMIN')]) {
      const app = as(user);
      expect((await request(app).get('/money/ledger')).status).toBe(200);
      expect((await request(app).get('/money/export?kind=ledger')).status).toBe(200);
      expect((await request(app).post('/money/ledger/manual').send({})).status).toBe(200);
    }
  });
  test('Support and Content manager still cannot even read the money screens', async () => {
    for (const role of ['SUPPORT', 'CONTENT_MANAGER']) {
      const app = as(staff(role));
      expect((await request(app).get('/money/deals/' + OID)).status).toBe(403);
      expect((await request(app).get('/money/ledger')).status).toBe(403);
    }
  });
  test('a buyer or partner (not an admin) and nobody signed in are refused', async () => {
    expect((await request(as({ role: 'PARTNER' })).get('/money/ledger')).status).toBe(403);
    expect((await request(as(null)).get('/money/ledger')).status).toBe(401);
  });
});
