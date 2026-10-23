jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  lead: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: { payments: { fetch: jest.fn() } } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ processingFee: { feeGstPct: 18 } }) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const ledger = require('../../src/modules/money/ledger.service');
const { razorpay } = require('../../src/lib/razorpay');
const { confirmPayment } = require('../../src/modules/escrow/escrow.service');

const row = (status) => ({ id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status, amount: 50000, chargedPaise: 5120900, processingFeePaise: 120900 });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
  prisma.lead.findUnique.mockResolvedValue({ property: { title: 'P' }, propertyInterest: null });
});

describe('confirmPayment after a failed attempt on the same order', () => {
  test('a payment captured on an order marked FAILED is recorded as HELD (webhook path)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(row('FAILED')).mockResolvedValueOnce({ ...row('HELD'), razorpayPaymentId: 'pay_2' });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    const out = await confirmPayment('order_1', 'pay_2');
    const call = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['PAYMENT_PENDING', 'FAILED'] });
    expect(call.data).toMatchObject({ status: 'HELD', razorpayPaymentId: 'pay_2', failedAt: null });
    expect(out.status).toBe('HELD');
    expect(ledger.onPaymentCaptured).toHaveBeenCalledTimes(1);
  });

  test('the buyer-facing check still verifies the payment with Razorpay before recording a FAILED order as paid', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row('FAILED'));
    razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'failed', amount: 5120900, currency: 'INR' });
    await expect(confirmPayment('order_1', 'pay_2', 'b1')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('a payment with the wrong amount is refused even on a FAILED order', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row('FAILED'));
    razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'captured', amount: 100, currency: 'INR' });
    await expect(confirmPayment('order_1', 'pay_2', 'b1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('an escrow that is already HELD or CANCELLED is left alone', async () => {
    for (const status of ['HELD', 'CANCELLED', 'REFUNDED']) {
      prisma.escrowTransaction.findUnique.mockResolvedValue(row(status));
      const out = await confirmPayment('order_1', 'pay_2');
      expect(out.status).toBe(status);
    }
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('if the lead already has another active order, the paid retry is flagged instead of lost', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row('FAILED'));
    const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: 'escrow_active_lead_unique' } });
    prisma.escrowTransaction.updateMany.mockRejectedValue(err);
    await expect(confirmPayment('order_1', 'pay_2')).rejects.toMatchObject({ statusCode: 409 });
  });
});
