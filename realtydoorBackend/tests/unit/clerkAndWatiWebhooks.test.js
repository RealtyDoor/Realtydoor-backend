// Clerk (svix-signed) and WATI (token) webhooks: forged, stale and replayed calls, and what each event may change.
const { Webhook } = require('svix');
jest.mock('../../src/lib/prisma', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  lead: { findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/lib/clerkAdmin', () => ({ setUserRole: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/wati/wati.service', () => ({ recordDeliveryEvent: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { setUserRole } = require('../../src/lib/clerkAdmin');
const { recordDeliveryEvent } = require('../../src/modules/wati/wati.service');
const { clerkWebhook } = require('../../src/modules/webhooks/clerk.handler');
const { watiWebhook } = require('../../src/modules/webhooks/wati.handler');

const SECRET = `whsec_${Buffer.from('unit-test-secret-for-svix').toString('base64')}`;
const ENV = { ...process.env };
const res = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

beforeEach(() => { jest.clearAllMocks(); process.env = { ...ENV, CLERK_WEBHOOK_SECRET: SECRET }; });
afterAll(() => { process.env = ENV; });

function signed(body, { id = 'msg_1', at = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const sig = new Webhook(secret).sign(id, new Date(at * 1000), raw);
  return { headers: { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': sig }, rawBody: Buffer.from(raw) };
}
const clerk = async (req) => { const r = res(); await clerkWebhook(req, r); return r; };

describe('Clerk webhook: who may call it', () => {
  test('no secret configured: 500, nothing processed', async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;
    expect((await clerk({ headers: {}, rawBody: Buffer.from('{}') })).statusCode).toBe(500);
  });
  test.each([['svix-id'], ['svix-timestamp'], ['svix-signature']])('missing %s is a 400', async (h) => {
    const req = signed({ type: 'user.deleted', data: { id: 'c1' } });
    delete req.headers[h];
    expect((await clerk(req)).statusCode).toBe(400);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  test('a body signed with a different secret is a 400', async () => {
    const req = signed({ type: 'user.deleted', data: { id: 'c1' } }, { secret: `whsec_${Buffer.from('attacker').toString('base64')}` });
    expect((await clerk(req)).statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('TAMPERING: changing the body after signing breaks the signature', async () => {
    const req = signed({ type: 'user.deleted', data: { id: 'c1' } });
    req.rawBody = Buffer.from(JSON.stringify({ type: 'user.deleted', data: { id: 'c-victim' } }));
    expect((await clerk(req)).statusCode).toBe(400);
  });
  test('REPLAY: a correctly signed call older than the tolerance is refused', async () => {
    const req = signed({ type: 'user.deleted', data: { id: 'c1' } }, { at: Math.floor(Date.now() / 1000) - 3600 });
    expect((await clerk(req)).statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('a timestamp far in the future is refused too', async () => {
    const req = signed({ type: 'user.deleted', data: { id: 'c1' } }, { at: Math.floor(Date.now() / 1000) + 3600 });
    expect((await clerk(req)).statusCode).toBe(400);
  });
  test('a signature header with several signatures is accepted when one is valid', async () => {
    const req = signed({ type: 'user.created', data: { id: 'c1' } });
    req.headers['svix-signature'] = `v1,AAAA ${req.headers['svix-signature']}`;
    prisma.user.findUnique.mockResolvedValue(null);
    expect((await clerk(req)).body).toEqual({ status: 'ok' });
  });
});

describe('Clerk webhook: what events change', () => {
  test('user.created only syncs the role label to Clerk; it creates no row', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'PARTNER' });
    await clerk(signed({ type: 'user.created', data: { id: 'c1' } }));
    expect(setUserRole).toHaveBeenCalledWith('c1', 'PARTNER');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('a brand-new user is labelled USER (never a role from the event body)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await clerk(signed({ type: 'user.created', data: { id: 'c1', public_metadata: { role: 'ADMIN' } } }));
    expect(setUserRole).toHaveBeenCalledWith('c1', 'USER');
  });
  test('user.updated for someone we never synced is skipped', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    expect((await clerk(signed({ type: 'user.updated', data: { id: 'c1', email_addresses: [{ email_address: 'a@x.in' }] } }))).body).toEqual({ status: 'ok' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('user.updated changes only email and phone, and NEVER role, name or anything else in the event', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'old@x.in', phone: '+911' });
    prisma.user.findFirst.mockResolvedValue(null);
    await clerk(signed({ type: 'user.updated', data: { id: 'c1', email_addresses: [{ email_address: 'new@x.in' }], public_metadata: { phone: '+912', role: 'ADMIN' }, first_name: 'Evil' } }));
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { email: 'new@x.in', phone: '+912' } });
  });
  test('an email or phone already owned by another account is skipped, the rest of the event still applies', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'old@x.in', phone: '+911' });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'other' }).mockResolvedValueOnce(null);
    await clerk(signed({ type: 'user.updated', data: { id: 'c1', email_addresses: [{ email_address: 'taken@x.in' }], public_metadata: { phone: '+912' } } }));
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ phone: '+912' });
  });
  test('losing a uniqueness race on the write is skipped (200), any other error is a 500 so Clerk retries', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'old@x.in' });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    expect((await clerk(signed({ type: 'user.updated', data: { id: 'c1', email_addresses: [{ email_address: 'n@x.in' }] } }))).statusCode).toBe(200);
    prisma.user.update.mockRejectedValueOnce(new Error('db down'));
    expect((await clerk(signed({ type: 'user.updated', data: { id: 'c1', email_addresses: [{ email_address: 'n@x.in' }] } }))).statusCode).toBe(500);
  });
  test('user.deleted soft-deletes once; a repeat or an unknown user changes nothing', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: null });
    await clerk(signed({ type: 'user.deleted', data: { id: 'c1' } }));
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { deletedAt: expect.any(Date) } });
    prisma.user.update.mockClear();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: new Date() });
    await clerk(signed({ type: 'user.deleted', data: { id: 'c1' } }));
    prisma.user.findUnique.mockResolvedValue(null);
    await clerk(signed({ type: 'user.deleted', data: { id: 'c1' } }));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('an event type we do not handle is acknowledged', async () => {
    expect((await clerk(signed({ type: 'session.created', data: { id: 's1' } }))).body).toEqual({ status: 'ok' });
  });
});

describe('WATI webhook', () => {
  const wati = async (body, { token = 'tok', headers = {}, query = {} } = {}) => {
    process.env.WATI_WEBHOOK_TOKEN = token === null ? '' : 'tok';
    if (token === null) delete process.env.WATI_WEBHOOK_TOKEN;
    const r = res();
    await watiWebhook({ headers, query, body }, r);
    return r;
  };
  const ok = { query: { token: 'tok' } };

  test('no token configured in production fails closed (503)', async () => {
    process.env.NODE_ENV = 'production';
    expect((await wati({ waId: '919', text: 'yes' }, { token: null })).statusCode).toBe(503);
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });
  test.each([[{}], [{ query: { token: 'wrong' } }], [{ query: { token: 'tokk' } }], [{ query: { token: ['tok'] } }], [{ headers: { 'x-wati-token': '' } }], [{ query: { token: 'TOK' } }]])('credentials %j are refused', async (cred) => {
    expect((await wati({ waId: '919', text: 'yes' }, cred)).statusCode).toBe(401);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('the token may come as a header or as ?token=', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    expect((await wati({ waId: '919', text: 'yes' }, { headers: { 'x-wati-token': 'tok' } })).body).toEqual({ status: 'no_matching_lead' });
    expect((await wati({ waId: '919', text: 'yes' }, ok)).body).toEqual({ status: 'no_matching_lead' });
  });
  test.each([['1', 'VERIFIED_CLOSED'], ['Yes', 'VERIFIED_CLOSED'], ['  INTERESTED ', 'VERIFIED_CLOSED'], ['2', 'VERIFIED_DROPPED'], ['no', 'VERIFIED_DROPPED'], ['Not Interested', 'VERIFIED_DROPPED'], ['3', 'STILL_DECIDING'], ['maybe', 'STILL_DECIDING'], ['still deciding', 'STILL_DECIDING']])('the reply %p records %s on the newest unanswered lead of that number', async (text, status) => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1' });
    const r = await wati({ waId: '919000000001', text }, ok);
    expect(r.body).toEqual({ status: 'ok' });
    expect(prisma.lead.findFirst.mock.calls[0][0]).toMatchObject({ where: { buyerPhone: '+919000000001', feedbackReceivedAt: null }, orderBy: { whatsappSentAt: 'desc' } });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { buyerFeedbackStatus: status, feedbackReceivedAt: expect.any(Date) } });
  });
  test.each([['yes please'], ['YES!'], ['4'], ['0'], ['maybe later'], [''], [' ']])('the reply %p is not a keyword and changes nothing', async (text) => {
    expect((await wati({ waId: '919000000001', text }, ok)).body).toEqual({ status: 'ignored' });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('REPLAY: once feedback is recorded, the same reply finds no open lead and cannot flip it', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    expect((await wati({ waId: '919000000001', text: 'no' }, ok)).body).toEqual({ status: 'no_matching_lead' });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a body with no number or no text is ignored; a missing body does not crash', async () => {
    expect((await wati({ text: 'yes' }, ok)).body).toEqual({ status: 'ignored' });
    expect((await wati({ waId: '919' }, ok)).body).toEqual({ status: 'ignored' });
    expect((await wati(undefined, ok)).body).toEqual({ status: 'ignored' });
  });
  test.each([['delivered', 'DELIVERED'], ['read', 'READ'], ['failed', 'FAILED'], ['sentMessage', 'SENT']])('delivery event %s is logged as %s and touches no lead', async (eventType, status) => {
    const r = await wati({ eventType, waId: '919', messageId: 'm1' }, ok);
    expect(r.body).toEqual({ status: 'ok', recorded: status });
    expect(recordDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({ status, messageId: 'm1', phone: '+919' }));
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });
  test('a database failure is a 500 with no detail', async () => {
    prisma.lead.findFirst.mockRejectedValue(new Error('mongo secret host'));
    const r = await wati({ waId: '919', text: 'yes' }, ok);
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('mongo');
  });
});
