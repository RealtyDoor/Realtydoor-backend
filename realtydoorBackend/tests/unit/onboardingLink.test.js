// Build-out form links the team can copy and resend (Nov 2026): the saved (encrypted) link, who can read it, and that it never leaves the server in a list or detail.
process.env.OTP_HASH_SECRET = 'test-secret-for-link-vault-0123456789';
const mockLive = { set: new Set() };
jest.mock('../../src/lib/prisma', () => {
  const models = {};
  return new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || model === '__esModule' || model === 'then') return undefined;
      if (model.startsWith('$')) { models[model] = models[model] || jest.fn(); return models[model]; }
      models[model] = models[model] || new Proxy({}, { get(m, fn) { if (typeof fn !== 'string') return undefined; m[fn] = m[fn] || jest.fn(); return m[fn]; } });
      return models[model];
    },
  });
});
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/fileUpload', () => ({ deleteFile: jest.fn(), copyFile: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendOnboardingFormReady: jest.fn().mockResolvedValue({}), sendOnboardingReceived: jest.fn(), sendOnboardingUpdate: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ sendOnboardingWhatsApp: jest.fn().mockResolvedValue({}), liveSet: () => mockLive.set }));

const prisma = require('../../src/lib/prisma');
const email = require('../../src/lib/email');
const audit = require('../../src/lib/auditLog');
const svc = require('../../src/modules/onboarding/onboarding.service');
const f = require('../../src/lib/onboardingForm');
const { encryptToken, decryptToken } = require('../../src/lib/linkVault');

const TOKEN = f.newToken();
const row = (over = {}) => ({
  id: 'r1', tokenHash: f.hashToken(TOKEN), tokenEnc: encryptToken(TOKEN), propertyType: 'NEW_PROJECT', title: 'Vrunda City', contactName: 'Ramesh Kumar',
  contactPhone: '+919800000001', contactEmail: 'ramesh@example.com', contactRole: 'BUILDER', status: 'SENT', data: {}, documents: [], adminNotes: [],
  expiresAt: new Date(Date.now() + 10 * 864e5), revokedAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockLive.set = new Set();
  process.env.FRONTEND_URL = 'https://www.realtydoor.com';
  email.sendOnboardingFormReady.mockResolvedValue({});
});

describe('the link vault', () => {
  test('a saved link reads back, and nothing else does', () => {
    const blob = encryptToken(TOKEN);
    expect(blob).not.toContain(TOKEN);
    expect(decryptToken(blob)).toBe(TOKEN);
    expect(decryptToken(blob.slice(0, -3) + 'AAA')).toBeNull();
    expect(decryptToken('not-a-blob')).toBeNull();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken(blob, { OTP_HASH_SECRET: 'a-different-secret-0123456789' })).toBeNull();
  });
  test('ONBOARDING_LINK_KEY, when set, is the key instead of OTP_HASH_SECRET', () => {
    const env = { OTP_HASH_SECRET: process.env.OTP_HASH_SECRET, ONBOARDING_LINK_KEY: 'dedicated-link-key-0123456789' };
    const blob = encryptToken(TOKEN, env);
    expect(decryptToken(blob, env)).toBe(TOKEN);
    expect(decryptToken(blob)).toBeNull();
  });
  test('no usable secret means no saved link, not a crash', () => {
    expect(encryptToken(TOKEN, {})).toBeNull();
    expect(encryptToken(TOKEN, { OTP_HASH_SECRET: 'short' })).toBeNull();
  });
  test('every encryption is different (fresh nonce)', () => {
    expect(encryptToken(TOKEN)).not.toBe(encryptToken(TOKEN));
  });
});

describe('the link is saved when it is made, and cleared when it closes', () => {
  test('create saves an encrypted copy that opens to the very token shown to the admin', async () => {
    prisma.onboardingRequest.create.mockImplementation(async ({ data }) => row({ ...data }));
    const out = await svc.adminCreate('a1', { propertyType: 'NEW_PROJECT', contactName: 'Ramesh Kumar' }, '1.1.1.1');
    const saved = prisma.onboardingRequest.create.mock.calls[0][0].data;
    expect(decryptToken(saved.tokenEnc)).toBe(out.token);
    expect(f.hashToken(out.token)).toBe(saved.tokenHash);
  });
  test('"New link" saves the new one', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => row({ ...data }));
    const out = await svc.adminReopen('a1', 'r1', 7, '1.1.1.1');
    expect(decryptToken(prisma.onboardingRequest.update.mock.calls[0][0].data.tokenEnc)).toBe(out.token);
  });
  test('switching the link off clears the saved copy', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => row({ ...data }));
    await svc.adminRevoke('a1', 'r1', '1.1.1.1');
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data).toMatchObject({ tokenEnc: null });
  });
});

describe('the saved link never reaches the browser in a list, detail, or any admin response', () => {
  const leaks = (value, r = row()) => {
    const text = JSON.stringify(value);
    return [r.tokenEnc, r.tokenHash, TOKEN, 'tokenEnc', 'tokenHash'].filter((needle) => text.includes(needle));
  };
  test('list', async () => {
    prisma.onboardingRequest.findMany.mockResolvedValue([row(), row({ id: 'r2', tokenEnc: null })]);
    prisma.onboardingRequest.count.mockResolvedValue(2);
    const out = await svc.adminList({}, 0, 20);
    expect(leaks(out)).toEqual([]);
    expect(out.data.map((x) => x.hasSavedLink)).toEqual([true, false]);
    expect(out.data[0]).toMatchObject({ hasEmail: true, hasPhone: true });
  });
  test('detail, update, note, reopen and revoke', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => row({ ...data, tokenEnc: data.tokenEnc === undefined ? row().tokenEnc : data.tokenEnc }));
    const detail = await svc.adminGet('r1');
    expect(leaks(detail)).toEqual([]);
    expect(detail.hasSavedLink).toBe(true);
    expect(leaks(await svc.adminUpdate('a1', 'r1', { title: 'x' }, 'ip'))).toEqual([]);
    expect(leaks(await svc.adminAddNote('a1', 'r1', 'hello', 'ip'))).toEqual([]);
    expect(leaks(await svc.adminRevoke('a1', 'r1', 'ip'))).toEqual([]);
    const reopened = await svc.adminReopen('a1', 'r1', 7, 'ip');
    const { token, ...withoutToken } = reopened; // the new token is shown to the admin once, by design; nothing else may carry it
    expect(JSON.stringify(withoutToken)).not.toContain(token);
    expect(JSON.stringify(withoutToken)).not.toContain('tokenEnc');
    expect(JSON.stringify(withoutToken)).not.toContain('tokenHash');
  });
});

describe('copy link', () => {
  test('returns the saved link and records who copied it', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    const out = await svc.adminCopyLink('a1', 'r1', '1.1.1.1');
    expect(out).toEqual({ token: TOKEN });
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONBOARDING_LINK_COPIED', targetId: 'r1' }));
  });
  test.each([
    ['a link made before links were saved', { tokenEnc: null }, 'NO_SAVED_LINK'],
    ['a saved value that no longer opens', { tokenEnc: 'v1.AAAA.BBBB.CCCC' }, 'NO_SAVED_LINK'],
    ['a switched-off link', { revokedAt: new Date() }, 'LINK_CLOSED'],
    ['an expired link', { expiresAt: new Date(Date.now() - 1000) }, 'LINK_CLOSED'],
    ['a request that became a listing', { status: 'CONVERTED', convertedToId: 'p1' }, 'LINK_CLOSED'],
  ])('refuses %s with a clear code, and records nothing', async (_n, over, code) => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row(over));
    await expect(svc.adminCopyLink('a1', 'r1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code } });
    expect(audit.createAuditLog).not.toHaveBeenCalled();
  });
  test('an unknown request is a plain 404', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(null);
    await expect(svc.adminCopyLink('a1', 'nope', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the message for an old link says what will happen to it', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ tokenEnc: null }));
    const err = await svc.adminCopyLink('a1', 'r1', 'ip').catch((e) => e);
    expect(err.message).toMatch(/New link/);
    expect(err.message).toMatch(/old link will stop working/);
  });
});

describe('resend', () => {
  const resend = async (id = 'r1') => { const out = await svc.adminResend('a1', id, '1.1.1.1'); await flush(); return out; };

  test('sends the SAME link again to the email on the request, and says what went out', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    const out = await resend('rs-a');
    expect(email.sendOnboardingFormReady).toHaveBeenCalledTimes(1);
    expect(email.sendOnboardingFormReady.mock.calls[0][0]).toBe('ramesh@example.com');
    expect(email.sendOnboardingFormReady.mock.calls[0][1].formUrl).toBe(`https://www.realtydoor.com/listing-form/${TOKEN}`);
    expect(out.notified).toEqual({ email: true, whatsapp: false, whatsappWaitingForTemplate: true });
    expect(prisma.onboardingRequest.update).not.toHaveBeenCalled(); // the link itself is untouched
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONBOARDING_LINK_RESENT' }));
  });
  test('a second click right away is refused, so nobody is emailed twice', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    await resend('rs-b');
    await expect(svc.adminResend('a1', 'rs-b', 'ip')).rejects.toMatchObject({ statusCode: 429, data: { code: 'RESEND_TOO_SOON' } });
    expect(email.sendOnboardingFormReady).toHaveBeenCalledTimes(1);
  });
  test('with no email and no live WhatsApp it sends nothing and says so, and does not start the pause', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ contactEmail: null }));
    const out = await resend('rs-c');
    expect(out.notified).toMatchObject({ email: false, whatsapp: false });
    expect(email.sendOnboardingFormReady).not.toHaveBeenCalled();
    const again = await resend('rs-c');
    expect(again.notified.email).toBe(false);
  });
  test('refuses the same closed links as copy', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ revokedAt: new Date() }));
    await expect(svc.adminResend('a1', 'rs-d', 'ip')).rejects.toMatchObject({ data: { code: 'LINK_CLOSED' } });
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ tokenEnc: null }));
    await expect(svc.adminResend('a1', 'rs-d', 'ip')).rejects.toMatchObject({ data: { code: 'NO_SAVED_LINK' } });
    expect(email.sendOnboardingFormReady).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  const fs = require('fs');
  const routes = fs.readFileSync(require('path').join(__dirname, '../../src/modules/admin/admin.routes.js'), 'utf8');
  test.each(['copy-link', 'resend'])('%s needs the LISTINGS permission and a valid id', (name) => {
    const line = routes.split('\n').find((l) => l.includes(`/onboarding/:id/${name}`));
    expect(line).toBeTruthy();
    expect(line).toContain("validateObjectId('id')");
    expect(line).toContain("requirePermission('LISTINGS')");
  });
});
