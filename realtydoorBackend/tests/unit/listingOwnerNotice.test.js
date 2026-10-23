// BUG-060: the partner who owns the listing is told when a token is received on it (no buyer details), once, and not when they are also the assigned partner.
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
const { createNotification } = require('../../src/lib/notifications');
const { confirmPayment } = require('../../src/modules/escrow/escrow.service');

const row = (status) => ({ id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status, amount: 50000, chargedPaise: 5120900, processingFeePaise: 120900 });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.findUnique.mockResolvedValueOnce(row('PAYMENT_PENDING')).mockResolvedValueOnce({ ...row('HELD'), razorpayPaymentId: 'pay_1' });
});

const sentTo = (userId) => createNotification.mock.calls.map((c) => c[0]).filter((n) => n.userId === userId);

describe('token received: the listing owner is told', () => {
  test('a different partner owns the listing: they get a notice with the property and amount, and no buyer details', async () => {
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'dev1', property: { id: 'p1', title: 'Plot A', partnerId: 'owner1' }, propertyInterest: null });
    await confirmPayment('order_1', 'pay_1');
    await flush();
    const n = sentTo('owner1');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: 'Token received on your listing', type: 'ESCROW_HELD', linkUrl: '/partners/listings/p1' });
    expect(n[0].message).toContain('₹50,000');
    expect(n[0].message).toContain('Plot A');
    expect(JSON.stringify(n[0])).not.toMatch(/b1|b@example/);
    expect(sentTo('b1')).toHaveLength(1); // the buyer still gets their own notice
  });
  test('the listing owner is also the assigned partner: no second notice', async () => {
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'owner1', property: { id: 'p1', title: 'Plot A', partnerId: 'owner1' }, propertyInterest: null });
    await confirmPayment('order_1', 'pay_1');
    await flush();
    expect(sentTo('owner1')).toHaveLength(0);
  });
  test('a lead without a listing owner still works', async () => {
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'dev1', property: null, propertyInterest: 'Somewhere' });
    await expect(confirmPayment('order_1', 'pay_1')).resolves.toMatchObject({ status: 'HELD' });
    await flush();
    expect(createNotification.mock.calls.filter((c) => c[0].userId !== 'b1')).toHaveLength(0);
  });
});
