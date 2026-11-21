// Duplicate or late payment (7 Nov 2026, owner's decision): when a captured payment arrives for an order whose lead already has an active token
// (the buyer paid twice, or paid a stale order after a new one was made), the extra payment is refunded in full automatically and admins are told.
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
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn().mockResolvedValue(), sendEscrowHeld: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue(), onRefund: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const { createAuditLog } = require('../../src/lib/auditLog');
const { notifyAdmins } = require('../../src/lib/notifications');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const ledger = require('../../src/modules/money/ledger.service');
const svc = require('../../src/modules/escrow/escrow.service');

const SETTINGS = jest.requireActual('../../src/modules/money/moneyConfig').parseSettings([]);
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


const dup = () => Object.assign(new Error('dup'), { code: 'P2002', meta: { target: 'escrow_active_lead_unique' } });
const row = (extra = {}) => ({ id: 'e2', leadId: 'l1', buyerId: 'b1', status: 'FAILED', amount: 50000, chargedPaise: 5120900, processingFeePaise: 120900, razorpayOrderId: 'order_old', refundIds: [], ...extra });

describe('confirmPayment: a captured payment for a lead that already has an active token', () => {
  beforeEach(() => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row());
    prisma.escrowTransaction.updateMany.mockRejectedValueOnce(dup()); // the HELD claim hits the unique index
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 }); // later claims succeed
  });

  test('refunds the whole payment (token and fee) and closes the extra row as refunded', async () => {
    rz.refundPayment.mockResolvedValue({ id: 'rfnd_dup' });
    await expect(svc.confirmPayment('order_old', 'pay_old')).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_DUPLICATE_PAYMENT' } });
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_old', 5120900);
    const claim = prisma.escrowTransaction.updateMany.mock.calls[1][0];
    expect(claim.where).toMatchObject({ razorpayOrderId: 'order_old', status: { in: ['PAYMENT_PENDING', 'FAILED'] } });
    expect(claim.data).toMatchObject({ status: 'REFUNDED', razorpayPaymentId: 'pay_old', refundReason: 'DUPLICATE_PAYMENT', refundedAmountPaise: 5120900 });
    expect(ledger.onRefund).toHaveBeenCalled();
    expect(createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'ESCROW_DUPLICATE_REFUNDED', targetId: 'e2' });
  });

  test('a second delivery of the same event refunds nothing (the row is no longer pending)', async () => {
    prisma.escrowTransaction.updateMany.mockReset();
    prisma.escrowTransaction.updateMany.mockRejectedValueOnce(dup());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 }); // someone else already claimed it
    await expect(svc.confirmPayment('order_old', 'pay_old')).rejects.toMatchObject({ data: { code: 'ESCROW_DUPLICATE_PAYMENT' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('if Razorpay cannot refund, the row goes back to what it was and admins are alerted to refund by hand', async () => {
    rz.refundPayment.mockRejectedValue({ statusCode: 400, error: { description: 'invalid request sent' } });
    await expect(svc.confirmPayment('order_old', 'pay_old')).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_DUPLICATE_PAYMENT' } });
    const revert = prisma.escrowTransaction.updateMany.mock.calls[2][0];
    expect(revert.data).toMatchObject({ status: 'FAILED', refundedAt: null });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/refund.*by hand|manual/i) }));
    // A low balance is named as the reason, with Razorpay's own words kept for whoever debugs it.
    expect(notifyAdmins.mock.calls[0][0].message).toMatch(/balance is too low.*top up/i);
    expect(notifyAdmins.mock.calls[0][0].message).toContain('invalid request sent');
  });
});

describe('the duplicate refunds what reached us, never Razorpay\'s own charge (owner, 20 Nov: token only; Customer Fee Bearer)', () => {
  beforeEach(() => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row());
    prisma.escrowTransaction.updateMany.mockRejectedValueOnce(dup());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    rz.refundPayment.mockResolvedValue({ id: 'rfnd_dup' });
  });
  test('Razorpay captured the order plus its fee: only the order amount is refunded, and the books match it', async () => {
    rz.razorpay.payments.fetch.mockResolvedValue({ id: 'pay_old', order_id: 'order_old', amount: 5120900 + 118000 });
    await expect(svc.confirmPayment('order_old', 'pay_old')).rejects.toMatchObject({ data: { code: 'ESCROW_DUPLICATE_PAYMENT' } });
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_old', 5120900);
    expect(prisma.escrowTransaction.updateMany.mock.calls[1][0].data.refundedAmountPaise).toBe(5120900);
    expect(ledger.onRefund.mock.calls[0][1].refundPaise).toBe(5120900);
  });
});
