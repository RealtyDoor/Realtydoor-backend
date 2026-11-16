// Audit Nov 2026, phase 7 (E2). Tests for the gates that had the least coverage: account sync (who gets in), listing conflict detection,
// the listing checklist, and disputes. See admin-nextjs/docs/AUDIT_2026-11.md.
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
const mockClerk = { verifyToken: jest.fn(), users: { getUser: jest.fn(), deleteUser: jest.fn() } };
jest.mock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => mockClerk }));
jest.mock('../../src/lib/clerkAdmin', () => ({ setUserRole: jest.fn(), syncUserFields: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendWelcomeEmail: jest.fn(() => Promise.resolve()), sendDisputeUpdate: jest.fn() }));
jest.mock('../../src/lib/refCode', () => ({ nextRefCode: jest.fn(async () => 'RD-U-000001') }));
jest.mock('../../src/lib/accountDeletion', () => ({ anonymizeUser: jest.fn(), hasMoneyInFlight: jest.fn(), revokeAllSessions: jest.fn(), getMoneyInFlightReasons: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn(), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/staffAlerts', () => ({ alertStaff: jest.fn(() => Promise.resolve()) }));

const prisma = require('../../src/lib/prisma');
const accountDeletion = require('../../src/lib/accountDeletion');
const notifications = require('../../src/lib/notifications');
const clerkAdmin = require('../../src/lib/clerkAdmin');

beforeEach(() => {
  jest.resetAllMocks();
  require('../../src/lib/refCode').nextRefCode.mockResolvedValue('RD-U-000001');
  require('../../src/lib/email').sendWelcomeEmail.mockResolvedValue();
  require('../../src/lib/staffAlerts').alertStaff.mockResolvedValue();
  notifications.createNotification.mockResolvedValue({});
  notifications.notifyAdmins.mockResolvedValue({});
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue({});
  clerkAdmin.setUserRole.mockResolvedValue();
  mockClerk.users.deleteUser.mockResolvedValue({});
});

// ── auth: syncUserByClerkId ────────────────────────────────────────────────
describe('auth sync: who is let in', () => {
  const { syncUserByClerkId, syncUser } = require('../../src/modules/auth/auth.service');
  const clerkUser = (over = {}) => ({
    emailAddresses: [{ emailAddress: 'Asha@Example.com ', verification: { status: 'verified' } }],
    firstName: 'Asha', lastName: 'K', phoneNumbers: [], imageUrl: 'x', publicMetadata: {}, createdAt: Date.now(), ...over,
  });

  test('a token that does not verify is a 401, not a server error', async () => {
    mockClerk.verifyToken.mockRejectedValue(new Error('bad'));
    await expect(syncUser('t')).rejects.toMatchObject({ statusCode: 401 });
  });
  test('no email on the identity is refused', async () => {
    await expect(syncUserByClerkId('c1', clerkUser({ emailAddresses: [] }))).rejects.toMatchObject({ statusCode: 400, data: { code: 'EMAIL_REQUIRED' } });
  });
  test('a first sign-in creates the row: lower-cased email, consent stamped, role USER, welcome email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    const { user } = await syncUserByClerkId('c1', clerkUser());
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clerkId: 'c1', email: 'asha@example.com', role: 'USER', refCode: 'RD-U-000001', emailVerified: true });
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(user.id).toBe('u1');
    expect(require('../../src/lib/email').sendWelcomeEmail).toHaveBeenCalled();
  });
  test('Clerk metadata cannot raise the role of an existing account: the database decides', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'c1', role: 'USER', isSuspended: false });
    prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    await syncUserByClerkId('c1', clerkUser({ publicMetadata: { role: 'ADMIN' } }));
    expect(prisma.user.update.mock.calls[0][0].data.role).toBe('USER');
  });
  test('a later sync does not rewrite the name, photo or reference code', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'c1', role: 'USER', name: 'Edited', refCode: 'RD-U-9' });
    prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    await syncUserByClerkId('c1', clerkUser());
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.name).toBeUndefined();
    expect(data.refCode).toBeUndefined();
    expect(require('../../src/lib/email').sendWelcomeEmail).not.toHaveBeenCalled();
  });
  test('a suspended account is refused with 403', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'c1', role: 'USER', isSuspended: true });
    await expect(syncUserByClerkId('c1', clerkUser())).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('the email of another identity: 409, and a brand-new duplicate Clerk identity is removed', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'u9', clerkId: 'other', emailVerified: true });
    mockClerk.users.deleteUser.mockResolvedValue({});
    await expect(syncUserByClerkId('c1', clerkUser())).rejects.toMatchObject({ statusCode: 409, data: { code: 'EXISTING_USER' } });
    expect(mockClerk.users.deleteUser).toHaveBeenCalledWith('c1');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
  test('an older identity is not deleted on a collision', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'u9', clerkId: 'other', emailVerified: true });
    await expect(syncUserByClerkId('c1', clerkUser({ createdAt: Date.now() - 3600 * 1000 }))).rejects.toMatchObject({ data: { code: 'EXISTING_USER' } });
    expect(mockClerk.users.deleteUser).not.toHaveBeenCalled();
  });
  test('a never-verified squatter on the email is cleared for a verified owner', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'u9', clerkId: 'other', emailVerified: false });
    accountDeletion.hasMoneyInFlight.mockResolvedValue(false);
    prisma.user.create.mockImplementation(async ({ data }) => ({ id: 'u2', ...data }));
    await syncUserByClerkId('c1', clerkUser());
    expect(accountDeletion.anonymizeUser).toHaveBeenCalledWith('u9');
    expect(prisma.user.create).toHaveBeenCalled();
  });
  test('a squatter with money in flight is never wiped', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'u9', clerkId: 'other', emailVerified: false });
    accountDeletion.hasMoneyInFlight.mockResolvedValue(true);
    await expect(syncUserByClerkId('c1', clerkUser())).rejects.toMatchObject({ data: { code: 'EXISTING_USER' } });
    expect(accountDeletion.anonymizeUser).not.toHaveBeenCalled();
  });
  test('a phone that belongs to another account is refused', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'c1', role: 'USER', phone: null });
    prisma.user.findFirst.mockResolvedValue({ id: 'u7' });
    await expect(syncUserByClerkId('c1', clerkUser({ phoneNumbers: [{ phoneNumber: '+919876543210' }] }))).rejects.toMatchObject({ data: { code: 'PHONE_IN_USE' } });
  });
  test('two syncs racing on a new row: the loser updates, keeps the winner’s refCode and sends no second welcome email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'u1' });
    prisma.user.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    await syncUserByClerkId('c1', clerkUser());
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.refCode).toBeUndefined();
    expect(require('../../src/lib/email').sendWelcomeEmail).not.toHaveBeenCalled();
  });
});

// ── integrity: detectConflicts ─────────────────────────────────────────────
describe('listing conflicts', () => {
  const integrity = require('../../src/modules/listings/integrity.service');
  const prop = (over = {}) => ({ id: 'a', title: 'A', address: '12, Green Park', pincode: '560066', floorNumber: 2, bhk: 3, partnerId: 'p1', publishStatus: 'PENDING_APPROVAL', locality: 'X', city: 'Bengaluru', ...over });

  test('a missing property is a 404', async () => {
    prisma.property.findUnique.mockResolvedValue(null);
    await expect(integrity.detectConflicts('a')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the same unit listed by another partner is a DUPLICATE_UNIT conflict, worded for a different partner', async () => {
    prisma.property.findUnique.mockResolvedValue(prop());
    prisma.property.findMany.mockResolvedValue([prop({ id: 'b', title: 'B', partnerId: 'p2', address: 'Green Park, 12' })]);
    prisma.exclusiveMandate.findMany.mockResolvedValue([]);
    prisma.listingConflict.findFirst.mockResolvedValue(null);
    prisma.listingConflict.create.mockImplementation(async ({ data }) => ({ id: 'c1', ...data }));
    const out = await integrity.detectConflicts('a');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'DUPLICATE_UNIT', conflictingPropertyId: 'b' });
    expect(out[0].detail).toMatch(/different partner/);
  });
  test('the same unit by the same partner is worded as the partner’s own earlier listing', async () => {
    prisma.property.findUnique.mockResolvedValue(prop());
    prisma.property.findMany.mockResolvedValue([prop({ id: 'b', title: 'B' })]);
    prisma.exclusiveMandate.findMany.mockResolvedValue([]);
    prisma.listingConflict.findFirst.mockResolvedValue(null);
    prisma.listingConflict.create.mockImplementation(async ({ data }) => ({ id: 'c1', ...data }));
    const out = await integrity.detectConflicts('a');
    expect(out[0].detail).toMatch(/already listed by this partner/);
  });
  test('a different floor is not the same unit', async () => {
    prisma.property.findUnique.mockResolvedValue(prop());
    prisma.property.findMany.mockResolvedValue([prop({ id: 'b', floorNumber: 3 })]);
    prisma.exclusiveMandate.findMany.mockResolvedValue([]);
    expect(await integrity.detectConflicts('a')).toEqual([]);
  });
  test('running it again does not pile up a second open conflict', async () => {
    prisma.property.findUnique.mockResolvedValue(prop());
    prisma.property.findMany.mockResolvedValue([prop({ id: 'b' })]);
    prisma.exclusiveMandate.findMany.mockResolvedValue([]);
    prisma.listingConflict.findFirst.mockResolvedValue({ id: 'open' });
    expect(await integrity.detectConflicts('a')).toEqual([]);
    expect(prisma.listingConflict.create).not.toHaveBeenCalled();
  });
  test('an agent whose mandate names their own PAN as the owner is flagged', async () => {
    prisma.property.findUnique.mockResolvedValue(prop({ address: null }));
    prisma.exclusiveMandate.findMany.mockResolvedValue([{ id: 'm1', ownerName: 'Ravi', ownerPan: 'abcde1234f', partnerId: 'p1', partner: { id: 'p1', name: 'Ravi', partnerSubType: 'AGENT', panNumber: 'ABCDE1234F' } }]);
    prisma.listingConflict.findFirst.mockResolvedValue(null);
    prisma.listingConflict.create.mockImplementation(async ({ data }) => ({ id: 'c1', ...data }));
    const out = await integrity.detectConflicts('a');
    expect(out.map((c) => c.type)).toEqual(['AGENT_OWNER_PAN_MATCH']);
  });
  test('two partners holding mandates on one unit is a MANDATE_OVERLAP; one partner holding both is not', async () => {
    prisma.property.findUnique.mockResolvedValue(prop());
    prisma.property.findMany.mockResolvedValue([prop({ id: 'b', partnerId: 'p2' })]);
    const mine = { id: 'm1', propertyId: 'a', partnerId: 'p1', ownerPan: null, partner: { id: 'p1', panNumber: null } };
    const theirs = { id: 'm2', propertyId: 'b', partnerId: 'p2', expiryDate: new Date('2027-01-01'), partner: { id: 'p2', name: 'Q', companyName: 'Q Realty' } };
    prisma.exclusiveMandate.findMany.mockResolvedValueOnce([mine]).mockResolvedValueOnce([theirs]);
    prisma.listingConflict.findFirst.mockResolvedValue(null);
    prisma.listingConflict.create.mockImplementation(async ({ data }) => ({ id: 'c', ...data }));
    const out = await integrity.detectConflicts('a');
    expect(out.map((c) => c.type)).toContain('MANDATE_OVERLAP');
    expect(out.find((c) => c.type === 'MANDATE_OVERLAP').detail).toMatch(/Q Realty.*2027-01-01/);
  });
  test('an owner report is stored, deduplicated, and every admin is told', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'a', title: 'A' });
    prisma.listingConflict.findFirst.mockResolvedValue(null);
    prisma.listingConflict.create.mockResolvedValue({ id: 'c1' });
    prisma.user.findMany.mockResolvedValue([{ id: 'ad1' }, { id: 'ad2' }]);
    notifications.broadcastNotification.mockResolvedValue({});
    const r = await integrity.recordOwnerReport('a', { reporterName: 'Owner', reporterContact: '9876', message: 'not mine' });
    expect(r).toMatchObject({ conflictCreated: true, conflictId: 'c1' });
    expect(notifications.broadcastNotification.mock.calls[0][0].userIds).toEqual(['ad1', 'ad2']);
  });
});

// ── checklist ──────────────────────────────────────────────────────────────
describe('listing checklist', () => {
  const checklist = require('../../src/modules/listings/checklist.service');
  test('each persona gets its own list', () => {
    expect(checklist.checklistFor('OWNER').documents.length).toBeGreaterThan(0);
    expect(checklist.checklistFor('AGENT').elsewhere.map((e) => e.item)).toContain('Mandate letter');
    expect(checklist.checklistFor('BUILDER').available).toBe(false);
    expect(checklist.checklistFor(undefined).available).toBe(false);
  });
  const base = { id: 'a', partnerId: 'p1', isMortgaged: false, hasCoOwners: false, reraNumber: null };
  function setup(prop, docs = []) {
    prisma.property.findUnique.mockResolvedValue({ ...base, ...prop });
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', name: 'P', partnerSubType: 'OWNER' });
    prisma.propertyDocument.findMany.mockResolvedValue(docs);
    prisma.exclusiveMandate.findFirst.mockResolvedValue(null);
    prisma.ownerConfirmation.findMany.mockResolvedValue([]);
  }
  test('someone else’s listing is refused for a partner', async () => {
    setup({});
    await expect(checklist.getChecklist('a', 'p9')).rejects.toMatchObject({ statusCode: 403 });
  });
  test('nothing uploaded: everything is missing and the listing is not ready', async () => {
    setup({});
    const c = await checklist.getChecklist('a');
    expect(c.missingCount).toBe(c.items.length);
    expect(c.ready).toBe(false);
  });
  test('a mortgaged listing adds the loan NOC; co-owners and a RERA number add theirs', async () => {
    setup({ isMortgaged: true, hasCoOwners: true, reraNumber: 'R1' });
    const c = await checklist.getChecklist('a');
    const types = c.items.map((i) => i.type);
    expect(types).toEqual(expect.arrayContaining(['LOAN_NOC', 'CO_OWNER_CONSENT', 'RERA_CERT']));
  });
  test('a rejected document counts as missing; an uploaded or verified one does not', async () => {
    setup({});
    const types = checklist.checklistFor('OWNER').documents.map((d) => d.type);
    const docs = types.map((t, i) => ({ id: `d${i}`, documentType: t, status: i === 0 ? 'REJECTED' : i === 1 ? 'PENDING' : 'VERIFIED' }));
    const c = await checklist.getChecklist('a');
    expect(c.missingCount).toBe(c.items.length);
    prisma.propertyDocument.findMany.mockResolvedValue(docs);
    const c2 = await checklist.getChecklist('a');
    expect(c2.missingCount).toBe(1);
    expect(c2.ready).toBe(false);
  });
  test('an owner confirmation past its deadline reads as timed out', async () => {
    setup({});
    prisma.ownerConfirmation.findMany.mockResolvedValue([{ id: 'o1', status: 'PENDING', expiresAt: new Date(Date.now() - 1000) }]);
    expect((await checklist.getChecklist('a')).ownerConfirmation.status).toBe('TIMED_OUT');
  });
  test('a missing property is a 404', async () => {
    prisma.property.findUnique.mockResolvedValue(null);
    await expect(checklist.getChecklist('a')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── disputes ───────────────────────────────────────────────────────────────
describe('disputes', () => {
  const d = require('../../src/modules/disputes/disputes.service');
  const input = { type: 'ESCROW', referenceId: 'e1', reason: 'r', description: 'desc' };
  test.each([['LEAD', 'lead'], ['ESCROW', 'escrowTransaction'], ['SERVICE', 'userSubscription']])('%s: only the owner of the record may dispute it', async (type, model) => {
    prisma[model].findFirst.mockResolvedValue(null);
    await expect(d.raiseDispute('u1', { ...input, type })).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.dispute.create).not.toHaveBeenCalled();
  });
  test('a second active dispute on the same record is refused', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
    prisma.dispute.findFirst.mockResolvedValue({ id: 'old' });
    await expect(d.raiseDispute('u1', input)).rejects.toMatchObject({ statusCode: 409 });
  });
  test('raising one stores it and tells every admin', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
    prisma.dispute.findFirst.mockResolvedValue(null);
    prisma.dispute.create.mockResolvedValue({ id: 'd1' });
    prisma.user.findMany.mockResolvedValue([{ id: 'ad1' }, { id: 'ad2' }]);
    prisma.user.findUnique.mockResolvedValue({ name: 'Buyer' });
    await d.raiseDispute('u1', input);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });
  test('a closed dispute cannot be changed; a missing one is a 404', async () => {
    prisma.dispute.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd1', status: 'CLOSED' });
    await expect(d.adminResolveDispute('d1', { status: 'RESOLVED' }, 'ad')).rejects.toMatchObject({ statusCode: 404 });
    await expect(d.adminResolveDispute('d1', { status: 'RESOLVED' }, 'ad')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('resolving stamps who and when, tells the buyer, and reminds admins when the token is still frozen', async () => {
    prisma.dispute.findUnique.mockResolvedValue({ id: 'd1', userId: 'u1', type: 'ESCROW', referenceId: 'e1', status: 'OPEN' });
    prisma.dispute.update.mockImplementation(async ({ data }) => ({ id: 'd1', ...data }));
    prisma.user.findUnique.mockResolvedValue({ email: null });
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'FROZEN' });
    await d.adminResolveDispute('d1', { status: 'RESOLVED', adminNote: 'ok' }, 'ad1');
    const data = prisma.dispute.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'RESOLVED', resolvedByAdminId: 'ad1' });
    expect(data.resolvedAt).toBeInstanceOf(Date);
    expect(notifications.createNotification.mock.calls[0][0]).toMatchObject({ userId: 'u1', type: 'DISPUTE_UPDATED' });
    await new Promise((r) => setImmediate(r));
    expect(notifications.notifyAdmins).toHaveBeenCalled();
  });
  test('moving to UNDER_REVIEW does not stamp a resolution', async () => {
    prisma.dispute.findUnique.mockResolvedValue({ id: 'd1', userId: 'u1', type: 'LEAD', referenceId: 'l1', status: 'OPEN' });
    prisma.dispute.update.mockImplementation(async ({ data }) => ({ id: 'd1', ...data }));
    prisma.user.findUnique.mockResolvedValue({ email: null });
    await d.adminResolveDispute('d1', { status: 'UNDER_REVIEW' }, 'ad1');
    expect(prisma.dispute.update.mock.calls[0][0].data.resolvedAt).toBeUndefined();
  });
});
