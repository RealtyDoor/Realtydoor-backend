// Privilege escalation inside the admin console. A limited staff admin (for example one given only USERS, or only STAFF) must not be
// able to turn someone into an UNRESTRICTED admin (an ADMIN with no staff role has every permission), nor hand out more than they hold,
// nor change an admin who outranks them. Real routes, controllers and services; the database is a recorder.
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/never';

const mockUsers = new Map();
const mockWrites = [];
jest.mock('../../../src/lib/prisma', () => {
  const user = {
    findUnique: jest.fn(async ({ where }) => (mockUsers.has(where.id) ? { ...mockUsers.get(where.id) } : null)),
    update: jest.fn(async ({ where, data }) => { mockWrites.push({ where, data }); return { ...mockUsers.get(where.id), ...data }; }),
  };
  return new Proxy({ user }, { get: (t, p) => (p in t ? t[p] : new Proxy({}, { get: () => jest.fn(async () => null) })) });
});
jest.mock('../../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = JSON.parse(req.headers['x-test-user']); next(); },
}));
jest.mock('../../../src/lib/clerkAdmin', () => ({ setUserRole: jest.fn().mockResolvedValue() }));
jest.mock('../../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../../src/middleware/auditAction', () => ({ auditAction: () => (req, res, next) => next() }));

const request = require('supertest');
const app = require('../../../src/app');

const O = (n) => `64b00000000000000000000${n}`;
const FULL = { id: O(1), role: 'ADMIN', staffRole: null, adminPermissions: [] };
const SUPER = { id: O(2), role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: [] };
const USERS_STAFF = { id: O(3), role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: ['USERS'] };
const STAFF_STAFF = { id: O(4), role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: ['STAFF', 'LEADS'] };
const BUYER = { id: O(5), role: 'USER', clerkId: 'c5', staffRole: null };
const OTHER_FULL_ADMIN = { id: O(6), role: 'ADMIN', clerkId: 'c6', staffRole: null, adminPermissions: [] };
const OTHER_SUPPORT = { id: O(7), role: 'ADMIN', clerkId: 'c7', staffRole: 'SUPPORT', adminPermissions: ['LEADS'] };

const as = (actor) => ({ 'x-test-user': JSON.stringify({ ...actor, onboardingComplete: true }) });
beforeEach(() => {
  mockWrites.length = 0;
  mockUsers.clear();
  [BUYER, OTHER_FULL_ADMIN, OTHER_SUPPORT, USERS_STAFF, STAFF_STAFF, FULL, SUPER].forEach((u) => mockUsers.set(u.id, { clerkId: `c-${u.id}`, ...u }));
});

describe('role changes (PATCH /api/admin/users/:id/role)', () => {
  const setRole = (actor, targetId, role) => request(app).patch(`/api/admin/users/${targetId}/role`).set(as(actor)).send({ role });

  test('ESCALATION: a staff admin who holds only USERS cannot make anyone an ADMIN', async () => {
    const res = await setRole(USERS_STAFF, BUYER.id, 'ADMIN');
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
  test('ESCALATION: nor demote or change an existing admin', async () => {
    expect((await setRole(USERS_STAFF, OTHER_FULL_ADMIN.id, 'USER')).status).toBe(403);
    expect((await setRole(USERS_STAFF, OTHER_SUPPORT.id, 'PARTNER')).status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
  test('a USERS staff admin can still move buyers and partners between USER and PARTNER (their normal job)', async () => {
    expect((await setRole(USERS_STAFF, BUYER.id, 'PARTNER')).status).toBe(200);
    expect(mockWrites[0].data).toEqual({ role: 'PARTNER' });
  });
  test.each([['an unrestricted admin', FULL], ['a super admin', SUPER]])('%s can make an admin', async (_n, actor) => {
    expect((await setRole(actor, BUYER.id, 'ADMIN')).status).toBe(200);
    expect(mockWrites.some((w) => w.data.role === 'ADMIN')).toBe(true);
  });
});

describe('the staff directory (/api/admin/staff/:id)', () => {
  const create = (actor, id, body) => request(app).post(`/api/admin/staff/${id}`).set(as(actor)).send(body);
  const update = (actor, id, body) => request(app).patch(`/api/admin/staff/${id}`).set(as(actor)).send(body);
  const remove = (actor, id) => request(app).delete(`/api/admin/staff/${id}`).set(as(actor));

  test('ESCALATION: a STAFF-scoped admin cannot make anyone a SUPER_ADMIN', async () => {
    expect((await create(STAFF_STAFF, BUYER.id, { staffRole: 'SUPER_ADMIN' })).status).toBe(403);
    expect((await update(STAFF_STAFF, OTHER_SUPPORT.id, { staffRole: 'SUPER_ADMIN' })).status).toBe(403);
    expect((await update(STAFF_STAFF, STAFF_STAFF.id, { staffRole: 'SUPER_ADMIN' })).status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
  test('ESCALATION: nor clear a staff role (an admin with no staff role has every permission)', async () => {
    expect((await update(STAFF_STAFF, OTHER_SUPPORT.id, { staffRole: null })).status).toBe(403);
    expect((await update(STAFF_STAFF, STAFF_STAFF.id, { staffRole: null })).status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
  test('ESCALATION: nor grant a permission they do not hold themselves', async () => {
    expect((await update(STAFF_STAFF, OTHER_SUPPORT.id, { permissions: ['LEADS', 'FINANCE'] })).status).toBe(403);
    expect((await update(STAFF_STAFF, STAFF_STAFF.id, { permissions: ['STAFF', 'LEADS', 'FINANCE'] })).status).toBe(403);
    expect((await create(STAFF_STAFF, BUYER.id, { staffRole: 'FINANCE_STAFF' })).status).toBe(403); // the FINANCE_STAFF preset includes FINANCE
    expect(mockWrites).toEqual([]);
  });
  test('ESCALATION: nor edit or remove an admin who outranks them (unrestricted or super)', async () => {
    expect((await update(STAFF_STAFF, OTHER_FULL_ADMIN.id, { permissions: [] })).status).toBe(403);
    expect((await update(STAFF_STAFF, SUPER.id, { permissions: [] })).status).toBe(403);
    expect((await remove(STAFF_STAFF, OTHER_FULL_ADMIN.id)).status).toBe(403);
    expect((await remove(STAFF_STAFF, SUPER.id)).status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
  test('a STAFF-scoped admin can still manage staff within what they hold (their normal job)', async () => {
    expect((await update(STAFF_STAFF, OTHER_SUPPORT.id, { permissions: ['LEADS'] })).status).toBeLessThan(300);
    expect((await create(STAFF_STAFF, BUYER.id, { staffRole: 'SUPPORT', permissions: ['LEADS'] })).status).toBeLessThan(300);
    expect((await remove(STAFF_STAFF, OTHER_SUPPORT.id)).status).toBeLessThan(300);
  });
  test.each([['an unrestricted admin', FULL], ['a super admin', SUPER]])('%s can grant anything', async (_n, actor) => {
    expect((await create(actor, BUYER.id, { staffRole: 'SUPER_ADMIN' })).status).toBeLessThan(300);
    expect((await update(actor, OTHER_SUPPORT.id, { staffRole: null })).status).toBeLessThan(300);
    expect((await update(actor, OTHER_SUPPORT.id, { permissions: ['FINANCE'] })).status).toBeLessThan(300);
  });
});
