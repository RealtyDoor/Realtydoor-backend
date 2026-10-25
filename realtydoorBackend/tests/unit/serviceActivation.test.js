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
