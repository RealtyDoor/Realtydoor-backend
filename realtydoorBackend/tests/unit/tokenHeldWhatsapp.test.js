// 28 Oct 2026: the assigned partner also gets the WhatsApp copy (template partner_token_held) when a token is held on their lead.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  lead: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: { payments: { fetch: jest.fn() } } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn().mockResolvedValue(), sendPartnerTaxInvoiceNeeded: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ processingFee: { feeGstPct: 18 } }) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { notifyUser } = require('../../src/lib/wati');
const { confirmPayment } = require('../../src/modules/escrow/escrow.service');

const row = (status) => ({ id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status, amount: 50000, chargedPaise: 5120900, processingFeePaise: 120900 });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.findUnique.mockResolvedValueOnce(row('PAYMENT_PENDING')).mockResolvedValueOnce({ ...row('HELD'), razorpayPaymentId: 'pay_1' });
});

test('the assigned partner gets partner_token_held with the lead reference, amount and property', async () => {
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-000107', assignedPartnerId: 'dev1', property: { id: 'p1', title: 'Plot A', partnerId: 'dev1' }, propertyInterest: null });
  await confirmPayment('order_1', 'pay_1');
  await flush();
  const call = notifyUser.mock.calls.find((c) => c[1] === 'partner_token_held');
  expect(call).toBeTruthy();
  expect(call[0]).toBe('dev1');
  expect(call[2]).toEqual({ partner_name: '$userName', lead_ref: 'RD-L-000107', amount: '50,000', property_title: 'Plot A' });
  expect(call[3]).toEqual({ leadId: 'l1' });
});

test('a lead with no assigned partner sends no partner message, and the buyer still gets the receipt message', async () => {
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-000108', assignedPartnerId: null, property: { id: 'p1', title: 'Plot A', partnerId: 'owner1' }, propertyInterest: null });
  await confirmPayment('order_1', 'pay_1');
  await flush();
  expect(notifyUser.mock.calls.some((c) => c[1] === 'partner_token_held')).toBe(false);
  expect(notifyUser.mock.calls.some((c) => c[0] === 'b1' && c[1] === 'escrow_token_received')).toBe(true);
});
