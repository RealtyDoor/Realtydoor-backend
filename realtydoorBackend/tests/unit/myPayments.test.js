// Owner, 24 Oct: after a refund the buyer's Wallet showed no payment and no receipt. GET /user/payments lists every captured payment.
jest.mock('../../src/lib/prisma', () => ({ escrowTransaction: { findMany: jest.fn() } }));
const prisma = require('../../src/lib/prisma');
const users = require('../../src/modules/users/users.service');

beforeEach(() => jest.clearAllMocks());

test('reads only this buyer\'s captured payments, newest first', async () => {
  prisma.escrowTransaction.findMany.mockResolvedValue([]);
  await users.getMyPayments('u1');
  const arg = prisma.escrowTransaction.findMany.mock.calls[0][0];
  expect(arg.where.buyerId).toBe('u1');
  expect(arg.where.status.in).toEqual(expect.arrayContaining(['HELD', 'RELEASED', 'REFUNDED']));
  expect(arg.where.status.in).not.toContain('PAYMENT_PENDING');
  expect(arg.orderBy).toEqual({ createdAt: 'desc' });
});

test('a refunded payment keeps its receipt and shows the refund', async () => {
  prisma.escrowTransaction.findMany.mockResolvedValue([{
    id: 'e1', leadId: 'l1', status: 'REFUNDED', amount: 50000, amountPaise: 5000000, processingFeePaise: 120900, chargedPaise: 5120900,
    heldAt: new Date('2026-10-23T10:00:00Z'), refundedAt: new Date('2026-10-23T12:00:00Z'), refundedAmountPaise: 5000000,
    razorpayPaymentId: 'pay_1', cancellationChargePaise: 0, lead: { refCode: 'RD-1', property: { title: 'Villa' } },
  }]);
  const [p] = await users.getMyPayments('u1');
  expect(p).toMatchObject({ id: 'e1', status: 'REFUNDED', tokenPaise: 5000000, processingFeePaise: 120900, paidPaise: 5120900, refundedPaise: 5000000, hasReceipt: true, hasFeeInvoice: true, propertyTitle: 'Villa', refCode: 'RD-1' });
});

test('a payment-failed-payout escrow looks HELD to the buyer, and no fee means no fee invoice', async () => {
  prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e2', leadId: 'l2', status: 'HELD_PAYOUT_FAILED', amount: 100, processingFeePaise: 0, heldAt: null, createdAt: new Date(), lead: { propertyInterest: 'Plot' } }]);
  const [p] = await users.getMyPayments('u1');
  expect(p).toMatchObject({ status: 'HELD', hasFeeInvoice: false, refundedPaise: null, propertyTitle: 'Plot', tokenPaise: 10000, paidPaise: 10000 });
});
