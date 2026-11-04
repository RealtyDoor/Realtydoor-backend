// Asking a partner for specific documents instead of rejecting, and what closes that request.
jest.mock('../../src/lib/prisma', () => ({
  user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  lead: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(5) }));
jest.mock('../../src/lib/wati', () => new Proxy({}, { get: () => jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const { createNotification } = require('../../src/lib/notifications');
const { createAuditLog } = require('../../src/lib/auditLog');
const admin = require('../../src/modules/admin/admin.service');
const partners = require('../../src/modules/partners/partners.service');
const { requestKycDocumentsSchema } = require('../../src/modules/admin/admin.validator');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'p1', name: 'Asha', ...data }));
});

describe('requestKycDocuments', () => {
  test('puts the partner in DOCUMENTS_REQUESTED with the checklist, the note and a due date, and tells them', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'PENDING_REVIEW' });
    const out = await admin.requestKycDocuments('p1', { items: ['PAN card, clearer copy', 'GST certificate'], note: 'Blurry scan', dueInDays: 7 }, 'adm1', '1.1.1.1');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ kycStatus: 'DOCUMENTS_REQUESTED', kycRequestedDocuments: ['PAN card, clearer copy', 'GST certificate'], kycRequestedNote: 'Blurry scan', kycRequestedByAdminId: 'adm1', kycRejectionNote: null });
    expect(data.kycRequestedDueAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(out.kycStatus).toBe('DOCUMENTS_REQUESTED');
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1', linkUrl: '/partners/profile' }));
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'KYC_DOCUMENTS_REQUESTED' }));
  });
  test('no deadline means no due date', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'REJECTED' });
    await admin.requestKycDocuments('p1', { items: ['RERA certificate'] }, 'adm1', 'ip');
    expect(prisma.user.update.mock.calls[0][0].data.kycRequestedDueAt).toBeNull();
  });
  test('a verified partner cannot be asked for documents', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'VERIFIED' });
    await expect(admin.requestKycDocuments('p1', { items: ['x y z'] }, 'adm1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('an unknown partner is a 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(admin.requestKycDocuments('nope', { items: ['x y z'] }, 'adm1', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('what the request has to look like', () => {
  test('1 to 20 items of 3 to 300 characters, an optional note and a deadline of at most 90 days', () => {
    expect(requestKycDocumentsSchema.safeParse({ items: ['PAN card'] }).success).toBe(true);
    expect(requestKycDocumentsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(requestKycDocumentsSchema.safeParse({ items: ['ab'] }).success).toBe(false);
    expect(requestKycDocumentsSchema.safeParse({ items: Array(21).fill('PAN card') }).success).toBe(false);
    expect(requestKycDocumentsSchema.safeParse({ items: ['PAN card'], dueInDays: 91 }).success).toBe(false);
    expect(requestKycDocumentsSchema.safeParse({ items: ['PAN card'], dueInDays: 7, note: 'x' }).success).toBe(true);
  });
});

describe('a decision or a resubmission closes the request', () => {
  const CLEARED = { kycRequestedDocuments: [], kycRequestedNote: null, kycRequestedAt: null, kycRequestedDueAt: null, kycRequestedByAdminId: null };
  test('approving clears the checklist', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'DOCUMENTS_REQUESTED', kycDocumentUrls: ['a.png'], panNumber: 'AABCR1234C' });
    await admin.verifyKyc('p1', 'APPROVE', null, 'adm1', 'ip');
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ kycStatus: 'VERIFIED', ...CLEARED });
  });
  test('rejecting clears the checklist', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'DOCUMENTS_REQUESTED', kycDocumentUrls: ['a.png'] });
    await admin.verifyKyc('p1', 'REJECT', 'Not readable', 'adm1', 'ip');
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ kycStatus: 'REJECTED', kycRejectionNote: 'Not readable', ...CLEARED });
  });
  test('the partner sending documents again goes back to review and clears it', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', kycStatus: 'DOCUMENTS_REQUESTED', kycConsentAt: new Date() });
    prisma.user.findMany.mockResolvedValue([{ id: 'adm1' }]);
    await partners.submitKyc('p1', ['new.png']);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ kycStatus: 'PENDING_REVIEW', kycDocumentUrls: ['new.png'], ...CLEARED });
  });
});
