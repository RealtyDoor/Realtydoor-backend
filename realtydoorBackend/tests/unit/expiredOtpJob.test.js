// 29 Oct 2026: the OTP cleanup job ran every 30 minutes and "released the lock" on every lead that had no lock at all (the date check
// matched leads whose lock field is null). Each of those leads got an update, so their updatedAt moved to "now" every half hour: the lead
// monitor showed wrong ages and "last activity", and partner finance showed old deals as closed today. The job must touch only leads that
// really have an expired lock or an expired code.
let mockJob;
jest.mock('node-cron', () => ({ schedule: (_expr, fn) => { mockJob = fn; } }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// A small stand-in for the leads table that applies the same rules as MongoDB for the fields this job reads.
const mockLeads = [
  { id: 'noLock', otpLockedUntil: null, siteVisitOTP: null, otpExpiresAt: null, isOtpVerified: false },
  { id: 'expiredLock', otpLockedUntil: new Date(Date.now() - 60e3), siteVisitOTP: null, otpExpiresAt: null, isOtpVerified: false },
  { id: 'liveLock', otpLockedUntil: new Date(Date.now() + 3600e3), siteVisitOTP: null, otpExpiresAt: null, isOtpVerified: false },
  { id: 'expiredCode', otpLockedUntil: null, siteVisitOTP: '123456', otpExpiresAt: new Date(Date.now() - 60e3), isOtpVerified: false },
];
const mockUpdates = [];
// Prisma on MongoDB treats a null field as matching `lte` unless the query also says `not: null` (that is the bug being tested).
function mockMatches(row, where) {
  return Object.entries(where).every(([field, cond]) => {
    const v = row[field];
    if (typeof cond !== 'object' || cond instanceof Date) return v === cond;
    return Object.entries(cond).every(([op, arg]) => {
      if (op === 'not') return arg === null ? v !== null : v !== arg;
      if (op === 'lte') return v === null || v <= arg; // the null case is the trap
      return true;
    });
  });
}
jest.mock('../../src/lib/prisma', () => ({
  lead: {
    findMany: jest.fn(async ({ where }) => mockLeads.filter((r) => mockMatches(r, where)).map((r) => ({ id: r.id }))),
    update: jest.fn(async ({ where, data }) => { mockUpdates.push({ id: where.id, data }); return {}; }),
  },
}));

require('../../src/jobs/expiredOtp').start();

beforeEach(() => { mockUpdates.length = 0; });

test('only leads with a real expired lock or code are touched; a lead with no lock is left alone', async () => {
  await mockJob();
  const touched = mockUpdates.map((u) => u.id).sort();
  expect(touched).toEqual(['expiredCode', 'expiredLock']);
  expect(touched).not.toContain('noLock');
  expect(touched).not.toContain('liveLock');
});
