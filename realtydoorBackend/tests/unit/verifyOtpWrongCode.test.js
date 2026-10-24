// BUG-026: a wrong visit code must answer 400 with the tries left, and the third wrong code must lock (429), never a 500.
jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(2), getConfigBool: jest.fn(), getConfig: jest.fn() }));
const prisma = require('../../src/lib/prisma');
const leads = require('../../src/modules/leads/leads.service');

const lead = (over = {}) => ({ id: 'l1', assignedPartnerId: 'p1', siteVisitOTP: '123456', otpAttempts: 0, otpLockedUntil: null,
  otpExpiresAt: new Date(Date.now() + 3600e3), siteVisitScheduledAt: new Date(Date.now() - 3600e3), ...over });

beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });

test('first wrong code: 400, two tries left, counter saved', async () => {
  prisma.lead.findFirst.mockResolvedValue(lead());
  await expect(leads.verifyOtp('l1', 'p1', '958251', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'LEAD_OTP_INVALID', attemptsLeft: 2 } });
  expect(prisma.lead.update.mock.calls[0][0].data.otpAttempts).toBe(1);
});

test('third wrong code locks the visit and says to contact admin', async () => {
  prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 2 }));
  await expect(leads.verifyOtp('l1', 'p1', '958251', '1.1.1.1')).rejects.toMatchObject({ statusCode: 429, data: { code: 'LEAD_OTP_LOCKED' } });
  expect(prisma.lead.update.mock.calls[0][0].data.otpLockedUntil).toBeInstanceOf(Date);
});

test('a lead stored without a counter still counts from zero', async () => {
  prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: undefined }));
  await expect(leads.verifyOtp('l1', 'p1', '958251', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400, data: { attemptsLeft: 2 } });
  expect(prisma.lead.update.mock.calls[0][0].data.otpAttempts).toBe(1);
});
