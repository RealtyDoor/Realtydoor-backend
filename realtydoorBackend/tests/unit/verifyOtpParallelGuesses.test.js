// Security pass 28 Oct 2026 (phase 2): the visit OTP has a 3-try lock, but the wrong-guess counter was read, added to and written back,
// so guesses sent at the same moment all read the same count and the lock never closed. The counter must be bumped atomically.
const mockDb = { lead: null };
jest.mock('../../src/lib/prisma', () => ({
  lead: {
    findFirst: jest.fn(async () => ({ ...mockDb.lead })),
    // Behaves like MongoDB: { increment: n } is applied to the stored value, a plain number replaces it.
    update: jest.fn(async ({ data }) => {
      for (const [k, v] of Object.entries(data)) {
        mockDb.lead[k] = v && typeof v === 'object' && 'increment' in v ? (mockDb.lead[k] || 0) + v.increment : v;
      }
      return { ...mockDb.lead };
    }),
  },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(2), getConfigBool: jest.fn(), getConfig: jest.fn() }));
const leads = require('../../src/modules/leads/leads.service');

beforeEach(() => {
  mockDb.lead = { id: 'l1', assignedPartnerId: 'p1', siteVisitOTP: '123456', otpAttempts: 0, otpLockedUntil: null,
    otpExpiresAt: new Date(Date.now() + 3600e3), siteVisitScheduledAt: new Date(Date.now() - 3600e3) };
});

test('five wrong guesses sent at once are all counted, and the lead ends up locked', async () => {
  const guesses = ['111111', '222222', '333333', '444444', '555555'];
  const results = await Promise.allSettled(guesses.map((g) => leads.verifyOtp('l1', 'p1', g, '1.1.1.1')));
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(mockDb.lead.otpAttempts).toBe(5);
  expect(mockDb.lead.otpLockedUntil).toBeInstanceOf(Date);
});

test('a guess after the lock is refused even if it is the right code', async () => {
  mockDb.lead.otpLockedUntil = new Date(Date.now() + 3600e3);
  await expect(leads.verifyOtp('l1', 'p1', '123456', '1.1.1.1')).rejects.toMatchObject({ statusCode: 429 });
  expect(mockDb.lead.isOtpVerified).toBeUndefined();
});
