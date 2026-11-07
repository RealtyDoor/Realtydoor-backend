jest.mock('../../src/lib/prisma', () => ({
  onboardingRequest: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/fileUpload', () => ({ deleteFile: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const { deleteFile } = require('../../src/lib/fileUpload');
const f = require('../../src/lib/onboardingForm');
const service = require('../../src/modules/onboarding/onboarding.service');
const { createSchema, convertSchema } = require('../../src/modules/onboarding/onboarding.controller');

const row = (over = {}) => ({
  id: 'r1', tokenHash: 'h', propertyType: 'NEW_PROJECT', title: 'Green Park', contactName: 'Asha', status: 'SENT',
  data: {}, documents: [], adminNotes: [], expiresAt: new Date(Date.now() + 86400000), revokedAt: null, ...over,
});

describe('tokens', () => {
  test('are long, random and only their hash is meant to be stored', () => {
    const a = f.newToken(); const b = f.newToken();
    expect(a).not.toBe(b);
    expect(f.looksLikeToken(a)).toBe(true);
    expect(f.hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(f.hashToken(a)).not.toContain(a);
  });
  test('a short or odd string is not a token', () => {
    for (const t of ['', 'abc', 'x'.repeat(100), '../etc/passwd', undefined, 42]) expect(f.looksLikeToken(t)).toBe(false);
  });
});

describe('sanitizeAnswers', () => {
  test('keeps text, numbers, yes/no, choice lists and unit rows; drops empties', () => {
    const out = f.sanitizeAnswers({
      a: '  hello ', b: 12, c: true, d: '', e: ['x', ' ', 'y'], f: [], g: null,
      unitTypes: [{ kind: 'Apartment', config: '2 BHK', count: 40 }, {}],
    });
    expect(out).toEqual({ a: 'hello', b: 12, c: true, e: ['x', 'y'], unitTypes: [{ kind: 'Apartment', config: '2 BHK', count: 40 }] });
  });
  test.each([
    [{ 'bad key': 1 }], [{ $where: 'x' }], [{ a: { nested: 1 } }], [{ a: 'x'.repeat(3001) }], [{ a: [1, 2] }], [[1]], ['text'], [{ a: [{ b: [1] }] }],
  ])('rejects %j', (input) => expect(() => f.sanitizeAnswers(input)).toThrow(/could not be saved|too much/));
  test('rejects a huge body and too many keys', () => {
    const big = {}; for (let i = 0; i < 301; i += 1) big[`k${i}`] = 'x';
    expect(() => f.sanitizeAnswers(big)).toThrow();
    const wide = {}; for (let i = 0; i < 100; i += 1) wide[`k${i}`] = 'x'.repeat(2000);
    expect(() => f.sanitizeAnswers(wide)).toThrow(/too much/);
  });
  test('nothing posted is an empty form', () => { expect(f.sanitizeAnswers(undefined)).toEqual({}); });
});

describe('linkState', () => {
  test('ok and editable while SENT or RECEIVED, locked once the team takes over', () => {
    expect(f.linkState(row())).toEqual({ state: 'ok', editable: true });
    expect(f.linkState(row({ status: 'RECEIVED' })).editable).toBe(true);
    for (const s of ['IN_DISCUSSION', 'READY', 'CONVERTED', 'CLOSED']) expect(f.linkState(row({ status: s })).editable).toBe(false);
  });
  test('revoked, expired and missing', () => {
    expect(f.linkState(row({ revokedAt: new Date() })).state).toBe('revoked');
    expect(f.linkState(row({ expiresAt: new Date(Date.now() - 1000) })).state).toBe('expired');
    expect(f.linkState(null).state).toBe('missing');
  });
  test('expiry is clamped to 1..60 days, default 14', () => {
    const days = (d) => Math.round((f.expiryFromDays(d).getTime() - Date.now()) / 86400000);
    expect(days(undefined)).toBe(14); expect(days(0)).toBe(1); expect(days(500)).toBe(60); expect(days(7)).toBe(7);
  });
});

describe('sender flow', () => {
  beforeEach(() => jest.clearAllMocks());
  const token = f.newToken();

  test('a bad or unknown link gets the same 404', async () => {
    await expect(service.senderGet('nope')).rejects.toMatchObject({ statusCode: 404, data: { code: 'LINK_INVALID' } });
    prisma.onboardingRequest.findFirst.mockResolvedValue(null);
    await expect(service.senderGet(token)).rejects.toMatchObject({ statusCode: 404 });
    prisma.onboardingRequest.findFirst.mockResolvedValue(row({ revokedAt: new Date() }));
    await expect(service.senderGet(token)).rejects.toMatchObject({ statusCode: 404 });
  });
  test('an expired link says so', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 5) }));
    await expect(service.senderGet(token)).rejects.toMatchObject({ statusCode: 410, data: { code: 'LINK_EXPIRED' } });
  });
  test('looks the row up by hash, never by the token itself', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row());
    await service.senderGet(token);
    expect(prisma.onboardingRequest.findFirst).toHaveBeenCalledWith({ where: { tokenHash: f.hashToken(token) } });
  });
  test('the sender never sees the bucket link or internal notes', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row({ documents: [{ id: 'd1', key: 'rera', name: 'a.pdf', size: 5, url: 'https://bucket/x', s3Key: 'onboarding/x', uploadedAt: 't' }], adminNotes: [{ text: 'secret' }] }));
    const v = await service.senderGet(token);
    expect(JSON.stringify(v)).not.toMatch(/bucket|s3Key|secret|adminNotes/);
    expect(v.documents[0]).toEqual({ id: 'd1', key: 'rera', name: 'a.pdf', size: 5, uploadedAt: 't' });
  });
  test('saving is refused once the team is in discussion', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row({ status: 'IN_DISCUSSION' }));
    await expect(service.senderSave(token, { data: { a: 'b' } })).rejects.toMatchObject({ statusCode: 409, data: { code: 'LINK_LOCKED' } });
    expect(prisma.onboardingRequest.update).not.toHaveBeenCalled();
  });
  test('saving stores cleaned answers', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row());
    prisma.onboardingRequest.update.mockResolvedValue({ lastSavedAt: 'now' });
    await service.senderSave(token, { data: { a: ' x ', b: '' } });
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data.data).toEqual({ a: 'x' });
  });
  test('submit needs something, then marks RECEIVED and tells the admins', async () => {
    prisma.onboardingRequest.findFirst.mockResolvedValue(row());
    await expect(service.senderSubmit(token, { data: {} })).rejects.toMatchObject({ data: { code: 'EMPTY_FORM' } });
    prisma.onboardingRequest.update.mockResolvedValue({});
    await service.senderSubmit(token, { data: { name: 'x' } });
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data).toMatchObject({ status: 'RECEIVED', data: { name: 'x' } });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'ONBOARDING_RECEIVED', linkUrl: '/admin/onboarding/r1' }));
  });
});

describe('documents', () => {
  beforeEach(() => jest.clearAllMocks());
  test('adds a file and returns it without its bucket link', async () => {
    prisma.onboardingRequest.update.mockResolvedValue({});
    const d = await service.attachDocument(row(), 'rera_certificate', { originalname: 'rera.pdf', size: 10, path: 'https://b/x', s3Key: 'onboarding/x.pdf' }, 'sender');
    expect(d).toMatchObject({ key: 'rera_certificate', name: 'rera.pdf', size: 10 });
    expect(d.url).toBeUndefined();
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data.documents[0]).toMatchObject({ url: 'https://b/x', s3Key: 'onboarding/x.pdf', by: 'sender' });
  });
  test('rejects an odd key', async () => {
    await expect(service.attachDocument(row(), '../x', { s3Key: 'k' }, 'sender')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('over the limit it refuses and removes the file it just stored', async () => {
    const docs = Array.from({ length: f.MAX_PER_DOC_KEY }, (_, i) => ({ id: `d${i}`, key: 'photos' }));
    await expect(service.attachDocument(row({ documents: docs }), 'photos', { s3Key: 'onboarding/new.png' }, 'sender')).rejects.toMatchObject({ data: { code: 'TOO_MANY_FILES' } });
    expect(deleteFile).toHaveBeenCalledWith('onboarding/new.png');
  });
  test('removing a file deletes it from the list and the bucket', async () => {
    prisma.onboardingRequest.update.mockResolvedValue({});
    await service.removeDocument(row({ documents: [{ id: 'd1', key: 'a', s3Key: 'onboarding/a' }, { id: 'd2', key: 'b' }] }), 'd1');
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data.documents).toEqual([{ id: 'd2', key: 'b' }]);
    expect(deleteFile).toHaveBeenCalledWith('onboarding/a');
    await expect(service.removeDocument(row(), 'zzz')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('admin side', () => {
  beforeEach(() => jest.clearAllMocks());
  test('create returns the secret once and stores only its hash', async () => {
    prisma.onboardingRequest.create.mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
    const out = await service.adminCreate('a1', { propertyType: 'PLOT', contactName: 'Ravi' }, '1.1.1.1');
    expect(f.looksLikeToken(out.token)).toBe(true);
    const stored = prisma.onboardingRequest.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(f.hashToken(out.token));
    expect(JSON.stringify(stored)).not.toContain(out.token);
    expect(out.tokenHash).toBeUndefined();
    expect(stored.status).toBe('SENT');
  });
  test('reopen swaps the secret so the old link dies, and lets the sender edit again', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ status: 'IN_DISCUSSION', revokedAt: new Date() }));
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }));
    const out = await service.adminReopen('a1', 'r1', 7);
    const d = prisma.onboardingRequest.update.mock.calls[0][0].data;
    expect(d).toMatchObject({ status: 'SENT', revokedAt: null, tokenHash: f.hashToken(out.token) });
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ status: 'CONVERTED' }));
    await expect(service.adminReopen('a1', 'r1')).rejects.toMatchObject({ statusCode: 409 });
  });
  test('admin cannot set SENT by a plain edit, and edited answers are cleaned', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    await expect(service.adminUpdate('a1', 'r1', { status: 'SENT' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.adminUpdate('a1', 'r1', { status: 'CONVERTED' })).rejects.toMatchObject({ statusCode: 400 });
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }));
    await service.adminUpdate('a1', 'r1', { status: 'IN_DISCUSSION', data: { a: ' b ' } });
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data).toMatchObject({ status: 'IN_DISCUSSION', data: { a: 'b' } });
  });
  test('a converted request is a closed record: no status change, no new link, no second listing', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ status: 'CONVERTED', convertedToId: 'prop1' }));
    await expect(service.adminUpdate('a1', 'r1', { status: 'RECEIVED' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'ALREADY_CONVERTED' } });
    await expect(service.adminReopen('a1', 'r1')).rejects.toMatchObject({ statusCode: 409 });
    // even one that was moved back before this rule existed
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ status: 'SENT', convertedToId: 'prop1' }));
    await expect(service.adminReopen('a1', 'r1')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.onboardingRequest.update).not.toHaveBeenCalled();
  });
  test('notes are appended with the admin id', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row());
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }));
    const out = await service.adminAddNote('a1', 'r1', 'called, wants 2BHK added');
    expect(out.adminNotes).toEqual([expect.objectContaining({ adminId: 'a1', text: 'called, wants 2BHK added' })]);
  });
  test('the admin view never carries the hash or bucket keys', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(row({ documents: [{ id: 'd', key: 'a', url: 'https://b/x', s3Key: 'onboarding/x' }] }));
    const v = await service.adminGet('r1');
    expect(v.tokenHash).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('s3Key');
    expect(v.documents[0].url).toBe('https://b/x');
  });
  test('convert input: a partner id, and createProject only as a real boolean', () => {
    const id = '64b000000000000000000001';
    expect(convertSchema.parse({ partnerId: id })).toEqual({ partnerId: id });
    expect(convertSchema.parse({ partnerId: id, createProject: true }).createProject).toBe(true);
    expect(() => convertSchema.parse({ partnerId: id, createProject: 'yes' })).toThrow();
    expect(() => convertSchema.parse({ partnerId: 'nope' })).toThrow();
  });
  test('create input is validated', () => {
    expect(() => createSchema.parse({ propertyType: 'CASTLE', contactName: 'Ravi' })).toThrow();
    expect(() => createSchema.parse({ propertyType: 'PLOT', contactName: 'R' })).toThrow();
    expect(createSchema.parse({ propertyType: 'PLOT', contactName: 'Ravi', contactPhone: '+91 98444 12345', contactEmail: '' })).toBeTruthy();
  });
});
