// A paid service subscription writes its ledger line, and a ledger problem never stops the activation notices.
jest.mock('../../src/lib/prisma', () => ({
  userSubscription: { findUnique: jest.fn(), updateMany: jest.fn() },
  service: { findUnique: jest.fn() },
  serviceTicket: { create: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: { payments: { fetch: jest.fn() } }, createOrder: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/email', () => ({ sendServiceActivated: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/cache', () => ({ withCache: (_k, _t, fn) => fn(), cacheDel: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ commission: { gstPct: 18 } }) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onServicePaid: jest.fn().mockResolvedValue({}) }));

const prisma = require('../../src/lib/prisma');
const { createNotification } = require('../../src/lib/notifications');
const ledger = require('../../src/modules/money/ledger.service');
const { activateSubscription } = require('../../src/modules/services/services.service');

const flush = () => new Promise((r) => setImmediate(r));
const pending = { id: 's1', userId: 'b1', serviceId: 'svc1', paymentStatus: 'PENDING', amountPaid: 2999, amountPaidPaise: 299900, razorpayOrderId: 'order_1' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.userSubscription.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, paymentStatus: 'SUCCESS', razorpayPaymentId: 'pay_1' });
  prisma.userSubscription.updateMany.mockResolvedValue({ count: 1 });
  prisma.service.findUnique.mockResolvedValue({ id: 'svc1', name: 'Home Loan Assistance' });
  prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
});

describe('activateSubscription', () => {
  test('writes the service revenue ledger line once the payment is confirmed (webhook path)', async () => {
    await activateSubscription('order_1', 'pay_1');
    await flush();
    expect(ledger.onServicePaid).toHaveBeenCalledTimes(1);
    expect(ledger.onServicePaid.mock.calls[0][0]).toMatchObject({ id: 's1', razorpayPaymentId: 'pay_1' });
    expect(ledger.onServicePaid.mock.calls[0][2]).toEqual({ gstPct: 18 });
  });
  test('a ledger failure still activates and still sends the notices', async () => {
    ledger.onServicePaid.mockRejectedValue(new Error('db down'));
    await expect(activateSubscription('order_1', 'pay_1')).resolves.toMatchObject({ paymentStatus: 'SUCCESS' });
    await flush();
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'SERVICE_ACTIVATED' }));
  });
});

// Razorpay's "Customer pays the fee" is account-wide, so a service payment can arrive as the price plus Razorpay's own charge (Nov 2026).
describe('service payments and the fee-bearer setting', () => {
  const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
  const { razorpay } = require('../../src/lib/razorpay');
  const { notifyAdmins } = require('../../src/lib/notifications');
  const settings = (bearer) => ({ commission: { gstPct: 18 }, processingFee: { bearer } });
  const withFee = 299900 + 7100; // price plus about 2.36%
  // Each test starts from an unpaid order (a test that throws early would otherwise leave a queued one-time value behind).
  beforeEach(() => { prisma.userSubscription.findUnique.mockReset(); prisma.userSubscription.findUnique.mockResolvedValue(pending); });

  test('CUSTOMER: the price plus Razorpay\'s charge activates the plan (buyer path)', async () => {
    getMoneySettings.mockResolvedValue(settings('CUSTOMER'));
    razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'captured', amount: withFee, currency: 'INR' });
    await activateSubscription('order_1', 'pay_1', 'b1');
    expect(prisma.userSubscription.updateMany).toHaveBeenCalled();
  });
  test('locked 20 Nov: even a stored PLATFORM setting accepts the price plus Razorpay\'s charge', async () => {
    getMoneySettings.mockResolvedValue(settings('PLATFORM'));
    razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'captured', amount: withFee, currency: 'INR' });
    await activateSubscription('order_1', 'pay_1', 'b1');
    expect(prisma.userSubscription.updateMany).toHaveBeenCalled();
  });
  test('CUSTOMER still refuses less than the price, and refuses much more', async () => {
    getMoneySettings.mockResolvedValue(settings('CUSTOMER'));
    razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'captured', amount: 299899, currency: 'INR' });
    await expect(activateSubscription('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ data: { code: 'AMOUNT_MISMATCH' } });
  });
  test('webhook path: a payment far above the price tells admins and does not activate', async () => {
    await activateSubscription('order_1', 'pay_1', null, { amount: withFee * 2, currency: 'INR' });
    expect(prisma.userSubscription.updateMany).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalled();
  });
});
