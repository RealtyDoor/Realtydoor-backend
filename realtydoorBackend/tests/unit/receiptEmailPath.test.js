// When a token payment is confirmed, the buyer's email carries our receipt PDF; if the PDF cannot be made, the email still goes, without it.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
  lead: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: { payments: { fetch: jest.fn() } } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn().mockResolvedValue(), sendPartnerTaxInvoiceNeeded: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ processingFee: { feeGstPct: 18 }, company: { legalName: 'Realtydoor tech private limited', gstin: '29AAQCR2118H1Z4' } }) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const email = require('../../src/lib/email');
const { confirmPayment } = require('../../src/modules/escrow/escrow.service');

const base = { id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', amount: 50000, chargedPaise: 5120900, processingFeePaise: 120900 };
const held = { ...base, status: 'HELD', razorpayPaymentId: 'pay_1', heldAt: new Date('2026-11-20T06:30:00Z'), lead: { refCode: 'RD-L-000107', buyerName: 'Anita Rao', property: { title: 'Plot A' }, propertyInterest: null } };
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.findUnique.mockResolvedValueOnce({ ...base, status: 'PAYMENT_PENDING' }).mockResolvedValueOnce(held);
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-000107', assignedPartnerId: null, property: { id: 'p1', title: 'Plot A', partnerId: 'owner1' }, propertyInterest: null });
});

test('the token-received email gets the receipt details and a real PDF', async () => {
  prisma.escrowTransaction.findFirst.mockResolvedValue(held);
  await confirmPayment('order_1', 'pay_1');
  await flush();
  expect(email.sendEscrowHeld).toHaveBeenCalledTimes(1);
  const [to, amount, fee, receipt] = email.sendEscrowHeld.mock.calls[0];
  expect(to).toBe('b@example.com');
  expect([amount, fee]).toEqual([50000, 120900]);
  expect(receipt).toMatchObject({ refCode: 'RD-L-000107', propertyTitle: 'Plot A', chargedPaise: 5120900, razorpayPaymentId: 'pay_1' });
  expect(Buffer.isBuffer(receipt.pdf)).toBe(true);
  expect(receipt.pdf.slice(0, 4).toString()).toBe('%PDF');
});

test('if the PDF cannot be made, the email still goes, without it', async () => {
  prisma.escrowTransaction.findFirst.mockResolvedValue(null);
  await confirmPayment('order_1', 'pay_1');
  await flush();
  expect(email.sendEscrowHeld).toHaveBeenCalledTimes(1);
  const receipt = email.sendEscrowHeld.mock.calls[0][3];
  expect(receipt.pdf).toBeUndefined();
  expect(receipt).toMatchObject({ refCode: 'RD-L-000107', razorpayPaymentId: 'pay_1' });
});
