// Payment audit 20 Nov 2026: the 15-minute catch-up job must hand Razorpay's own amount to the
// service-plan activation, so the order-amount check runs there too (it used to activate with no check).
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/prisma', () => {
  const m = () => ({ findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0) });
  return { escrowTransaction: m(), userSubscription: m(), lead: m(), user: m(), platformConfig: m() };
});
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: { orders: { fetch: jest.fn(), fetchPayments: jest.fn() }, payouts: { fetch: jest.fn() } },
  rawGet: jest.fn(),
}));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ confirmPayment: jest.fn() }));
jest.mock('../../src/modules/services/services.service', () => ({ activateSubscription: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/payoutAlerts', () => ({ onPayoutFailed: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPayoutStatus: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/staffAlerts', () => ({ alertStaff: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { razorpay } = require('../../src/lib/razorpay');
const { activateSubscription } = require('../../src/modules/services/services.service');
const { runOnce } = require('../../src/jobs/paymentReconcile');

test('a paid service order found by the catch-up job is activated WITH Razorpay\'s amount, so it is checked', async () => {
  prisma.userSubscription.findMany.mockResolvedValue([{ id: 's1', razorpayOrderId: 'order_s1' }]);
  razorpay.orders.fetch.mockResolvedValue({ status: 'paid' });
  razorpay.orders.fetchPayments.mockResolvedValue({ items: [{ id: 'pay_s1', status: 'captured', amount: 307000, currency: 'INR' }] });
  await runOnce();
  expect(activateSubscription).toHaveBeenCalledWith('order_s1', 'pay_s1', null, { amount: 307000, currency: 'INR' });
});
