// The buyer's list of paid services and the receipt for each (found live 25 Oct 2026: service purchases were nowhere in Payments).
jest.mock('../../src/lib/prisma', () => ({
  userSubscription: { findMany: jest.fn(), findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ commission: { gstPct: 18 }, company: { legalName: 'RealtyDoor', gstin: null } }) }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { serviceReceiptLines } = require('../../src/lib/pdfReceipt');
const users = require('../../src/modules/users/users.service');

const sub = {
  id: 's1', userId: 'b1', paymentStatus: 'SUCCESS', amountPaid: 2999, amountPaidPaise: 299900, razorpayPaymentId: 'pay_Ts2MXYZ',
  startDate: new Date('2026-10-25T17:00:00Z'), endDate: new Date('2027-10-25T17:00:00Z'),
  service: { name: 'Home Loan Assistance', category: 'LOAN' },
};

describe('serviceReceiptLines', () => {
  test('shows the price paid, the GST inside it and the amount before GST', () => {
    expect(serviceReceiptLines({ amountPaise: 299900, gstPct: 18 })).toEqual([
      { label: 'Service fee before GST', value: 'Rs. 2,541.53' },
      { label: 'GST at 18% (included in the price)', value: 'Rs. 457.47' },
      { label: 'Total paid', value: 'Rs. 2,999', strong: true },
    ]);
  });
});

describe('getMyServicePayments', () => {
  test('lists only this buyer\'s successful subscriptions, newest first, with the GST split and the validity', async () => {
    prisma.userSubscription.findMany.mockResolvedValue([sub]);
    const rows = await users.getMyServicePayments('b1');
    expect(prisma.userSubscription.findMany.mock.calls[0][0].where).toEqual({ userId: 'b1', paymentStatus: 'SUCCESS' });
    expect(prisma.userSubscription.findMany.mock.calls[0][0].orderBy).toEqual({ startDate: 'desc' });
    expect(rows).toEqual([{
      id: 's1', serviceName: 'Home Loan Assistance', category: 'LOAN', paidPaise: 299900, gstPaise: 45747, netPaise: 254153,
      paidAt: sub.startDate, validUntil: sub.endDate, paymentId: 'pay_Ts2MXYZ', hasReceipt: true,
    }]);
  });
});

describe('getServiceReceipt', () => {
  test('another buyer\'s subscription is a 404', async () => {
    prisma.userSubscription.findFirst.mockResolvedValue(null);
    await expect(users.getServiceReceipt('b2', 's1')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.userSubscription.findFirst.mock.calls[0][0].where).toMatchObject({ id: 's1', userId: 'b2', paymentStatus: 'SUCCESS' });
  });
  test('the buyer\'s own paid subscription gives a PDF', async () => {
    prisma.userSubscription.findFirst.mockResolvedValue(sub);
    prisma.user.findUnique.mockResolvedValue({ name: 'Krishna M' });
    const pdf = await users.getServiceReceipt('b1', 's1');
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });
});
