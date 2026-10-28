// The site-visit OTP lifecycle: scheduling issues a code, resend never resets the lock, only the assigned partner can verify,
// every refusal leaves the lead and the contact details alone, and success reveals the number exactly once.
jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn(), update: jest.fn() }, user: { findMany: jest.fn() } }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue(), createNotification: jest.fn().mockResolvedValue(), broadcastNotification: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ sendSiteVisitOtp: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(2), getConfigBool: jest.fn(), getConfig: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { sendSiteVisitOtp } = require('../../src/lib/wati');
const { notifyAdmins, broadcastNotification } = require('../../src/lib/notifications');
const { assertLeadNotPaused } = require('../../src/lib/accountDeletion');
const leads = require('../../src/modules/leads/leads.service');

const HOUR = 3600e3;
const lead = (over = {}) => ({
  id: 'l1', refCode: 'RD-L-1', assignedPartnerId: 'p1', buyerId: 'b1', buyerName: 'Buyer', buyerPhone: '+919000000001', status: 'SITE_VISIT_SCHEDULED',
  siteVisitOTP: '123456', otpAttempts: 0, otpLockedUntil: null, otpExpiresAt: new Date(Date.now() + HOUR), siteVisitScheduledAt: new Date(Date.now() - HOUR), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.lead.update.mockImplementation(async ({ data }) => ({ ...lead(), ...data, buyerPhone: '+919000000001' }));
  prisma.user.findMany.mockResolvedValue([{ id: 'adm1' }]);
});

describe('scheduleVisit', () => {
  test('is scoped to the assigned partner (another partner gets a 404 and nothing is sent)', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(leads.scheduleVisit('l1', 'p2', new Date())).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', assignedPartnerId: 'p2' });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
  });
  test('a closed lead cannot be scheduled', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status: 'CLOSED' }));
    await expect(leads.scheduleVisit('l1', 'p1', new Date())).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a buyer whose account is being deleted blocks it', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    assertLeadNotPaused.mockRejectedValueOnce(Object.assign(new Error('paused'), { statusCode: 409 }));
    await expect(leads.scheduleVisit('l1', 'p1', new Date())).rejects.toThrow('paused');
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('issues a fresh 6-digit code, clears any lock and attempt count, and sends it by WhatsApp only', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 2, otpLockedUntil: new Date(Date.now() + HOUR) }));
    const when = new Date(Date.now() + 24 * HOUR);
    const out = await leads.scheduleVisit('l1', 'p1', when);
    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data.siteVisitOTP).toMatch(/^[1-9]\d{5}$/);
    expect(data).toMatchObject({ status: 'SITE_VISIT_SCHEDULED', otpAttempts: 0, otpLockedUntil: null });
    expect(data.otpExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sendSiteVisitOtp).toHaveBeenCalledWith('+919000000001', data.siteVisitOTP);
    expect(JSON.stringify(out)).not.toContain(data.siteVisitOTP); // the partner must never be handed the code
  });
  test('the codes are not predictable: 200 draws are not all the same', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) { await leads.scheduleVisit('l1', 'p1', new Date()); seen.add(prisma.lead.update.mock.calls[i][0].data.siteVisitOTP); }
    expect(seen.size).toBeGreaterThan(150);
  });
  test('a WhatsApp failure is logged and does not fail the booking', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    sendSiteVisitOtp.mockRejectedValueOnce(new Error('WATI down'));
    await expect(leads.scheduleVisit('l1', 'p1', new Date())).resolves.toBeTruthy();
  });
});

describe('resendOtp', () => {
  test('needs a scheduled visit', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ siteVisitScheduledAt: null }));
    await expect(leads.resendOtp('l1', 'p1')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a locked lead cannot resend: lock is the only way out through admin', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpLockedUntil: new Date(Date.now() + HOUR) }));
    await expect(leads.resendOtp('l1', 'p1')).rejects.toMatchObject({ statusCode: 429, data: { code: 'LEAD_OTP_LOCKED' } });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
  });
  test('a resend never resets the attempt counter or the lock (it is not a free retry)', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 2 }));
    await leads.resendOtp('l1', 'p1');
    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('otpAttempts');
    expect(data).not.toHaveProperty('otpLockedUntil');
    expect(data.siteVisitOTP).toMatch(/^\d{6}$/);
  });
  test('a lock that has already run out no longer blocks', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpLockedUntil: new Date(Date.now() - 1000) }));
    await expect(leads.resendOtp('l1', 'p1')).resolves.toBeTruthy();
  });
});

describe('requestOtpOverride', () => {
  test('only a locked lead can ask', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    await expect(leads.requestOtpOverride('l1', 'p1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('asking only raises a flag and tells the admins; it never unlocks', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpLockedUntil: new Date(Date.now() + HOUR) }));
    await leads.requestOtpOverride('l1', 'p1');
    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ otpOverrideRequestedByPartner: true });
    expect(data).not.toHaveProperty('otpLockedUntil');
    expect(data).not.toHaveProperty('siteVisitOTP');
    expect(broadcastNotification).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['adm1'], type: 'OTP_OVERRIDE_REQUESTED' }));
  });
  test("another partner's lead is a 404", async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(leads.requestOtpOverride('l1', 'p2')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('verifyOtp', () => {
  const ref = (o) => leads.verifyOtp('l1', 'p1', o, '9.9.9.9');
  const refusedWithoutChange = () => {
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  };

  test("another partner's lead is a 404 and no attempt is counted", async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(leads.verifyOtp('l1', 'p2', '123456', 'ip')).rejects.toMatchObject({ statusCode: 404 });
    refusedWithoutChange();
  });
  test('a lead with no code issued is a 400, and an empty guess can never match a missing code', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ siteVisitOTP: null }));
    for (const guess of ['', undefined, null]) await expect(ref(guess)).rejects.toMatchObject({ statusCode: 400 });
    refusedWithoutChange();
  });
  test('a locked lead refuses even the CORRECT code', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpLockedUntil: new Date(Date.now() + HOUR) }));
    await expect(ref('123456')).rejects.toMatchObject({ statusCode: 429, data: { code: 'LEAD_OTP_LOCKED' } });
    refusedWithoutChange();
  });
  test('an expired code is refused even if correct, and counts no attempt', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpExpiresAt: new Date(Date.now() - 1000) }));
    await expect(ref('123456')).rejects.toMatchObject({ statusCode: 400, message: 'OTP has expired' });
    refusedWithoutChange();
  });
  test('a missing expiry counts as expired', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpExpiresAt: null }));
    await expect(ref('123456')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('before the early window the code cannot be used and does not burn a try', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ siteVisitScheduledAt: new Date(Date.now() + 5 * HOUR) }));
    await expect(ref('000000')).rejects.toMatchObject({ data: { code: 'VISIT_NOT_STARTED' } });
    await expect(ref('123456')).rejects.toMatchObject({ data: { code: 'VISIT_NOT_STARTED' } });
    refusedWithoutChange();
  });
  test.each([[123456], ['12345'], ['1234567'], [' 123456'], ['123456 '], ['12345a'], [['123456']], [{ a: 1 }], [true]])('a guess of %p is not the code', async (guess) => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    await expect(ref(guess)).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update.mock.calls[0][0].data.otpAttempts).toEqual({ increment: 1 });
  });
  test('a wrong code never reveals the phone number or the real code', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    const err = await ref('000000').catch((e) => e);
    expect(JSON.stringify(err)).not.toMatch(/9000000001|123456/);
  });
  test('the right code completes the visit, reveals the number once, records who saw it from where, and burns the code', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    const out = await ref('123456');
    expect(out.buyerPhone).toBe('+919000000001');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({
      isOtpVerified: true, status: 'SITE_VISIT_DONE', siteVisitOTP: null, contactRevealedByPartnerId: 'p1', contactRevealedIp: '9.9.9.9',
    });
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    // the code is gone, so replaying it is refused
    prisma.lead.findFirst.mockResolvedValue(lead({ siteVisitOTP: null }));
    await expect(ref('123456')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('the correct code on the last allowed try still works', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 2 }));
    await expect(ref('123456')).resolves.toMatchObject({ message: expect.stringContaining('verified') });
  });
});
