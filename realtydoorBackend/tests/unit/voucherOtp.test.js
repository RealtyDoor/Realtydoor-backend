// Commission voucher accepted by OTP: only the partner it was issued to can ask for or enter the code; wrong codes count and lock;
// an expired or already-used code does nothing; the code is stored only as a hash and never returned.
process.env.OTP_HASH_SECRET = 'unit-test-secret-0123456789';
jest.mock('../../src/lib/prisma', () => ({
  commissionVoucher: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ sendVoucherOtp: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({}));

const crypto = require('crypto');
const prisma = require('../../src/lib/prisma');
const { sendVoucherOtp } = require('../../src/lib/wati');
const tax = require('../../src/modules/money/partnerTax.service');

const hash = (c) => crypto.createHmac('sha256', process.env.OTP_HASH_SECRET).update(c).digest('hex');
const voucher = (over = {}) => ({ id: 'v1', partnerId: 'p1', voucherNumber: 'CV-1', status: 'ISSUED', otpHash: hash('123456'), otpExpiresAt: new Date(Date.now() + 5 * 60e3), otpAttempts: 0, otpSentAt: null, netPaise: 98000, ...over });

beforeEach(() => {
  jest.resetAllMocks();
  prisma.commissionVoucher.update.mockResolvedValue({});
  prisma.commissionVoucher.updateMany.mockResolvedValue({ count: 1 });
  prisma.commissionVoucher.findUnique.mockResolvedValue(voucher({ status: 'ACCEPTED', otpHash: null }));
});

describe('requestVoucherOtp', () => {
  test("another partner's voucher is a 404 (the lookup includes the partner)", async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(null);
    await expect(tax.requestVoucherOtp('p2', 'v1', 'ip')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.commissionVoucher.findFirst.mock.calls[0][0].where).toEqual({ id: 'v1', partnerId: 'p2' });
    expect(sendVoucherOtp).not.toHaveBeenCalled();
  });
  test('an accepted voucher needs no code', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ status: 'ACCEPTED' }));
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'VOUCHER_ACCEPTED' } });
  });
  test('a second request within the cooldown is a 429 and sends nothing', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpSentAt: new Date(Date.now() - 10e3) }));
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ statusCode: 429, data: { code: 'OTP_TOO_SOON' } });
    expect(sendVoucherOtp).not.toHaveBeenCalled();
  });
  test.each([[{ phone: null, phoneVerified: true }], [{ phone: '+919', phoneVerified: false }], [null]])('a partner with phone state %j gets no code', async (p) => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    prisma.user.findUnique.mockResolvedValue(p);
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ data: { code: 'PHONE_NOT_VERIFIED' } });
    expect(sendVoucherOtp).not.toHaveBeenCalled();
  });
  test('the code is stored only as a hash, sent to the partner\'s verified phone, and never returned', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: null }));
    prisma.user.findUnique.mockResolvedValue({ phone: '+919000000001', phoneVerified: true });
    sendVoucherOtp.mockResolvedValue(true);
    const out = await tax.requestVoucherOtp('p1', 'v1', 'ip');
    const sent = sendVoucherOtp.mock.calls[0][1];
    expect(sent).toMatch(/^\d{6}$/);
    expect(sendVoucherOtp.mock.calls[0][0]).toBe('+919000000001');
    const stored = prisma.commissionVoucher.update.mock.calls[0][0].data;
    expect(stored.otpHash).toBe(hash(sent));
    expect(stored.otpHash).not.toContain(sent);
    expect(stored.otpAttempts).toBe(0);
    expect(JSON.stringify(out)).not.toContain(sent);
  });
  test('if the message could not be sent the stored code and the cooldown are cleared so the partner can retry at once', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: null }));
    prisma.user.findUnique.mockResolvedValue({ phone: '+919', phoneVerified: true });
    sendVoucherOtp.mockResolvedValue(null);
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ statusCode: 503, data: { code: 'OTP_SEND_FAILED' } });
    expect(prisma.commissionVoucher.update.mock.calls[1][0].data).toEqual({ otpHash: null, otpExpiresAt: null, otpAttempts: 0, otpSentAt: null });
  });
});

describe('acceptVoucher', () => {
  test("another partner's voucher is a 404", async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(null);
    await expect(tax.acceptVoucher('p2', 'v1', '123456', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('no code requested yet, or an expired one, is OTP_EXPIRED even for the right digits', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: null }));
    await expect(tax.acceptVoucher('p1', 'v1', '123456', 'ip')).rejects.toMatchObject({ data: { code: 'OTP_EXPIRED' } });
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpExpiresAt: new Date(Date.now() - 1000) }));
    await expect(tax.acceptVoucher('p1', 'v1', '123456', 'ip')).rejects.toMatchObject({ data: { code: 'OTP_EXPIRED' } });
    expect(prisma.commissionVoucher.updateMany).not.toHaveBeenCalled();
  });
  test('after the allowed wrong tries the right code is refused too (OTP_LOCKED)', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpAttempts: 5 }));
    await expect(tax.acceptVoucher('p1', 'v1', '123456', 'ip')).rejects.toMatchObject({ statusCode: 429, data: { code: 'OTP_LOCKED' } });
    expect(prisma.commissionVoucher.updateMany).not.toHaveBeenCalled();
  });
  test.each([['000000'], ['12345'], ['1234567'], [''], [undefined], [null], [{}]])('a wrong code %j counts one attempt and accepts nothing', async (code) => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    await expect(tax.acceptVoucher('p1', 'v1', code, 'ip')).rejects.toMatchObject({ data: { code: 'OTP_WRONG' } });
    expect(prisma.commissionVoucher.update.mock.calls[0][0].data).toEqual({ otpAttempts: { increment: 1 } });
    expect(prisma.commissionVoucher.updateMany).not.toHaveBeenCalled();
  });
  test('the right code accepts once, records the IP, and burns the stored hash', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    await tax.acceptVoucher('p1', 'v1', '123456', '9.9.9.9');
    expect(prisma.commissionVoucher.updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', status: 'ISSUED' },
      data: expect.objectContaining({ status: 'ACCEPTED', acceptedIp: '9.9.9.9', otpHash: null }),
    });
  });
  test('REPLAY / RACE: an already-accepted voucher is returned as is, and a lost claim does not audit twice', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ status: 'ACCEPTED' }));
    await tax.acceptVoucher('p1', 'v1', '000000', 'ip');
    expect(prisma.commissionVoucher.updateMany).not.toHaveBeenCalled();
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    prisma.commissionVoucher.updateMany.mockResolvedValue({ count: 0 });
    await tax.acceptVoucher('p1', 'v1', '123456', 'ip');
    expect(require('../../src/lib/auditLog').createAuditLog).not.toHaveBeenCalled();
  });
  test('publicVoucher removes the code material before anything is shown', () => {
    expect(Object.keys(tax.publicVoucher(voucher()))).not.toEqual(expect.arrayContaining(['otpHash', 'otpAttempts', 'otpExpiresAt', 'otpSentAt']));
  });
});

describe('the route schema in front of acceptVoucher', () => {
  const { voucherAcceptSchema } = require('../../src/modules/money/money.validator');
  test('only six digits as text get through (a number or a list that would print as the code is refused before the service)', () => {
    expect(voucherAcceptSchema.safeParse({ code: '123456' }).success).toBe(true);
    for (const code of [123456, ['123456'], '12345', '1234567', '12345a', ' 123456', '', null, undefined, { a: 1 }]) {
      expect(voucherAcceptSchema.safeParse({ code }).success).toBe(false);
    }
  });
});
