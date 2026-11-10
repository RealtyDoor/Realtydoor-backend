// Manual refund (7 Nov 2026): the admin pays the buyer outside Razorpay (its balance is too low) and records it here with a bank reference and a
// reason. Razorpay is never called, the same caps and locks as a normal refund apply, and one admin is enough.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  escrowTransaction: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: { payments: { fetch: jest.fn() }, orders: { fetch: jest.fn(), fetchPayments: jest.fn() } },
  createEscrowOrder: jest.fn(), refundPayment: jest.fn(),
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn().mockResolvedValue(), sendEscrowHeld: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue(), onRefund: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const { createAuditLog } = require('../../src/lib/auditLog');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const ledger = require('../../src/modules/money/ledger.service');
const svc = require('../../src/modules/escrow/escrow.service');

const SETTINGS = jest.requireActual('../../src/modules/money/moneyConfig').parseSettings([]);
const held = (extra = {}) => ({
  id: 'e1', leadId: 'l1', buyerId: 'b1', status: 'HELD', amount: 50000, processingFeePaise: 120900,
  razorpayPaymentId: 'pay_1', razorpayPayoutId: null, razorpayPartnerPayoutId: null, refundedAmountPaise: 0, refundIds: [], heldAt: new Date(), ...extra,
});
const REASON = 'Buyer agreed a partial goodwill refund';

beforeEach(() => {
  jest.resetAllMocks();
  getMoneySettings.mockResolvedValue(SETTINGS);
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-1', assignedPartnerId: null, allocationLetterVerifiedAt: null, property: { title: 'Flat' } });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.update.mockResolvedValue({ id: 'e1' });
  prisma.user.findUnique.mockResolvedValue(null);
  rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
});

const REF = 'UTR 4521 8890 12';
const call = (extra = {}, id = 'e1') => svc.refundManually(id, 'a1', '1.1.1.1', { amountPaise: 24_998_00, reference: REF, reason: 'Razorpay balance too low, paid by bank transfer', ...extra });

describe('refundManually', () => {
  test('records a part refund without calling Razorpay, with ledger, audit and a notification', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', amount: 49998, refundedAmountPaise: 25_000_00 }));
    await call();
    expect(rz.refundPayment).not.toHaveBeenCalled();
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 'e1', status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 25_000_00 });
    expect(claim.data).toMatchObject({ status: 'REFUNDED', refundedAmountPaise: 49_998_00 });
    expect(ledger.onRefund).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ refundPaise: 24_998_00, reason: 'ADMIN_MANUAL' }), expect.objectContaining({ actor: { createdByType: 'ADMIN', createdById: 'a1' } }));
    const audit = createAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({ adminId: 'a1', action: 'ESCROW_REFUNDED_MANUALLY', reason: 'Razorpay balance too low, paid by bank transfer' });
    expect(audit.after).toMatchObject({ reference: REF, refundPaise: 24_998_00 });
  });

  test('a part amount leaves the token part-refunded', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await call({ amountPaise: 10_000_00 });
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 10_000_00 });
  });

  test.each([[''], ['ab'], ['   '], [undefined], ['x'.repeat(101)]])('reference %p is a 400', async (reference) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(call({ reference })).rejects.toMatchObject({ statusCode: 400, data: { code: 'REFERENCE_REQUIRED' } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test.each([[''], ['abc'], [undefined], ['x'.repeat(501)]])('reason %p is a 400', async (reason) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(call({ reason })).rejects.toMatchObject({ statusCode: 400, data: { code: 'REASON_REQUIRED' } });
  });

  test.each([[0], [-1], [1.5], [NaN], ['100']])('amount %p is a 400', async (amountPaise) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(call({ amountPaise })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('never more than what is still refundable', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ refundedAmountPaise: 49_000_00 }));
    await expect(call({ amountPaise: 2_000_00 })).rejects.toMatchObject({ statusCode: 400, data: { code: 'AMOUNT_TOO_HIGH' } });
  });

  test.each(['RELEASED', 'REFUNDED', 'FROZEN', 'PAYMENT_PENDING', 'FAILED'])('a %s token is refused', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status }));
    await expect(call()).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('a token with a payout on file is refused', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ razorpayPayoutId: 'pout_1' }));
    await expect(call()).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_HAS_PAYOUTS' } });
  });

  test('refused after the allocation letter is verified', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterVerifiedAt: new Date() });
    await expect(call()).rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' } });
  });

  test('losing the race to another admin records nothing', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(call()).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_CHANGED' } });
    expect(ledger.onRefund).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  test('unknown escrow is a 404', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });
});
