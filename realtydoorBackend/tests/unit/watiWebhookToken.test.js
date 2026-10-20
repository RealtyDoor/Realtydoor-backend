jest.mock('../../src/lib/prisma', () => ({}));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/modules/wati/wati.service', () => ({ recordDeliveryEvent: jest.fn() }));

const { watiWebhook } = require('../../src/modules/webhooks/wati.handler');

function run({ headers = {}, query = {}, token = 'secret-token-123' }) {
  process.env.WATI_WEBHOOK_TOKEN = token;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  const req = { headers, query, body: {} };
  return Promise.resolve(watiWebhook(req, res)).then(() => res.statusCode);
}

describe('WATI webhook token', () => {
  afterAll(() => { delete process.env.WATI_WEBHOOK_TOKEN; });

  it('rejects a request with no token', async () => { expect(await run({})).toBe(401); });
  it('rejects a wrong token in the header or the URL', async () => {
    expect(await run({ headers: { 'x-wati-token': 'nope' } })).toBe(401);
    expect(await run({ query: { token: 'nope' } })).toBe(401);
  });
  it('rejects a non-string token (?token[]=...)', async () => { expect(await run({ query: { token: ['secret-token-123'] } })).toBe(401); });
  it('accepts the right token from the header or from ?token=', async () => {
    expect(await run({ headers: { 'x-wati-token': 'secret-token-123' } })).not.toBe(401);
    expect(await run({ query: { token: 'secret-token-123' } })).not.toBe(401);
  });
});
