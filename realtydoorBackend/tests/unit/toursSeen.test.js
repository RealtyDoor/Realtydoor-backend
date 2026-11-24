// 24 Nov 2026: the backend remembers which in-app walkthroughs a person has seen.
jest.mock('../../src/lib/prisma', () => ({ user: { update: jest.fn().mockResolvedValue({}) } }));
const prisma = require('../../src/lib/prisma');
const { markTourSeen, resetToursSeen } = require('../../src/modules/auth/auth.controller');
const { limitedStaffMayReach } = require('../../src/lib/staffLockdown');

const run = async (body, user = { id: 'u1', toursSeen: [] }) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let err;
  await markTourSeen({ body, user }, res, (e) => { err = e; });
  return { res, err };
};

beforeEach(() => prisma.user.update.mockClear());

test('records a new tour id for the signed-in person', async () => {
  const { res, err } = await run({ id: 'welcome-buyer' });
  expect(err).toBeUndefined();
  expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { toursSeen: { push: 'welcome-buyer' } } });
  expect(res.body.data.toursSeen).toEqual(['welcome-buyer']);
});

test('a tour already seen is not written again', async () => {
  const { res } = await run({ id: 'welcome-buyer' }, { id: 'u1', toursSeen: ['welcome-buyer'] });
  expect(prisma.user.update).not.toHaveBeenCalled();
  expect(res.body.data.toursSeen).toEqual(['welcome-buyer']);
});

test.each([undefined, '', 'Has Spaces', 'UPPER', '../x', 'a', 'x'.repeat(80), 42, { $ne: 1 }])('refuses a bad id %p', async (id) => {
  const { err } = await run({ id });
  expect(err).toMatchObject({ statusCode: 400 });
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('the list is capped', async () => {
  const full = Array.from({ length: 200 }, (_, i) => `tour-${i}`);
  await run({ id: 'one-more' }, { id: 'u1', toursSeen: full });
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('a receptionist or BDE can reach it (it lives under /api/auth)', () => {
  const recep = { role: 'ADMIN', staffRole: 'RECEPTION', adminPermissions: ['RECEPTION'] };
  expect(limitedStaffMayReach(recep, '/api/auth/tours/seen')).toBe(true);
});

test('replay: resets only the signed-in person\'s own list', async () => {
  const res = { body: null, json(b) { this.body = b; return this; }, status() { return this; } };
  await resetToursSeen({ user: { id: 'u1', toursSeen: ['a', 'b'] }, body: { id: 'ignored', userId: 'someone-else' } }, res, () => {});
  expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { toursSeen: [] } });
  expect(res.body.data.toursSeen).toEqual([]);
});
