// release(): every refusal that must happen BEFORE money moves, and the double-release claim. Money is never sent in these tests.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  lead: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  leadCommissionLine: { findMany: jest.fn() },
  platformConfig: { findMany: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: {}, createEscrowOrder: jest.fn(), refundPayment: jest.fn(),
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({}));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const svc = require('../../src/modules/escrow/escrow.service');

const held = (extra = {}) => ({ id: 'e1', leadId: 'l1', status: 'HELD', amount: 50000, razorpayPaymentId: 'pay_1', ...extra });
const readyLead = (extra = {}) => ({
  id: 'l1', refCode: 'RD-L-1', feePct: null, dealPriceAtLock: null, commissionLockedAt: new Date(), commissionVersion: 1,
  allocationLetterUrl: 'u', allocationLetterVerifiedAt: new Date(), buyerFeedbackStatus: null, status: 'CLOSED',
  assignedPartnerId: null, property: { price: 1e7 }, assignedPartner: null, ...extra,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.platformConfig.findMany.mockResolvedValue([]);
  prisma.leadCommissionLine.findMany.mockResolvedValue([]);
  prisma.escrowTransaction.findUnique.mockResolvedValue(held());
  prisma.lead.findUnique.mockResolvedValue(readyLead());
});

const noMoneyMoved = () => {
  expect(rz.createPayout).not.toHaveBeenCalled();
  expect(rz.createPayoutContact).not.toHaveBeenCalled();
};

test('an unknown escrow is a 404', async () => {
  prisma.escrowTransaction.findUnique.mockResolvedValue(null);
  await expect(svc.release('x', 'a1', {}, 'ip')).rejects.toMatchObject({ statusCode: 404 });
});

test.each(['PAYMENT_PENDING', 'RELEASED', 'REFUNDED', 'FROZEN', 'PARTIALLY_REFUNDED', 'HELD_PAYOUT_FAILED'])('DOUBLE RELEASE: an escrow in %s cannot be released', async (status) => {
  prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status }));
  await expect(svc.release('e1', 'a1', { overrideConditions: true, overrideReason: 'x' }, 'ip')).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  noMoneyMoved();
});

test('a payment that was never captured cannot be released', async () => {
  prisma.escrowTransaction.findUnique.mockResolvedValue(held({ razorpayPaymentId: null }));
  await expect(svc.release('e1', 'a1', {}, 'ip')).rejects.toMatchObject({ statusCode: 400 });
});

describe('release conditions', () => {
  test('BUG-049: an allocation letter that is on file but not verified blocks the release', async () => {
    prisma.lead.findUnique.mockResolvedValue(readyLead({ allocationLetterVerifiedAt: null }));
    await expect(svc.release('e1', 'a1', {}, 'ip')).rejects.toMatchObject({ statusCode: 400, data: { code: 'RELEASE_CONDITIONS_UNMET', unmet: ['ALLOCATION_LETTER'] } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('no letter and no locked commission are both listed', async () => {
    prisma.lead.findUnique.mockResolvedValue(readyLead({ allocationLetterUrl: null, allocationLetterVerifiedAt: null, commissionLockedAt: null }));
    await expect(svc.release('e1', 'a1', {}, 'ip')).rejects.toMatchObject({ data: { unmet: ['COMMISSION_LOCKED', 'ALLOCATION_LETTER'] } });
  });

  test('overriding the conditions needs a written reason', async () => {
    prisma.lead.findUnique.mockResolvedValue(readyLead({ allocationLetterVerifiedAt: null }));
    await expect(svc.release('e1', 'a1', { overrideConditions: true }, 'ip')).rejects.toMatchObject({ data: { code: 'OVERRIDE_REASON_REQUIRED' } });
    await expect(svc.release('e1', 'a1', { overrideConditions: true, overrideReason: '' }, 'ip')).rejects.toMatchObject({ data: { code: 'OVERRIDE_REASON_REQUIRED' } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('with a reason the override reaches the claim', async () => {
    prisma.lead.findUnique.mockResolvedValue(readyLead({ allocationLetterVerifiedAt: null }));
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.release('e1', 'a1', { overrideConditions: true, overrideReason: 'settled offline' }, 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).toHaveBeenCalledTimes(1);
  });

  test('a falsy override flag is not an override', async () => {
    prisma.lead.findUnique.mockResolvedValue(readyLead({ allocationLetterVerifiedAt: null }));
    await expect(svc.release('e1', 'a1', { overrideConditions: 0, overrideReason: 'x' }, 'ip')).rejects.toMatchObject({ data: { code: 'RELEASE_CONDITIONS_UNMET' } });
  });
});

describe('the claim and the amounts', () => {
  test('RACE: of two releases only the one that wins the HELD->RELEASED claim goes on; the loser sends nothing', async () => {
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.release('e1', 'a1', { sellerDetails: { name: 'S', email: 's@x.in', phone: '9999999999' } }, 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'e1', status: 'HELD' } }));
    noMoneyMoved();
  });

  test('an old-style partnerDetails without a positive partnerShare is refused before any claim', async () => {
    const partnerDetails = { name: 'P', email: 'p@x.in', phone: '9999999999' };
    for (const partnerShare of [undefined, 0, -5]) {
      await expect(svc.release('e1', 'a1', { partnerDetails, partnerShare }, 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_SHARE_REQUIRED' } });
    }
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('a partner share equal to or above the held token is refused (the seller cannot get zero or less)', async () => {
    const partnerDetails = { name: 'P', email: 'p@x.in', phone: '9999999999' };
    for (const partnerShare of [50000, 50001, 1e9]) {
      await expect(svc.release('e1', 'a1', { partnerDetails, partnerShare, payPartner: true }, 'ip')).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    noMoneyMoved();
  });
});

describe('freeze and unfreeze', () => {
  test('only a held escrow can be frozen, only a frozen one unfrozen', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'RELEASED' }));
    await expect(svc.freeze('e1', 'dispute', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'HELD' }));
    await expect(svc.unfreeze('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
});
