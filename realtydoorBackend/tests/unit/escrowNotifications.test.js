// Everyone who needs to know is told, in the app: the buyer, the assigned partner and the admins hear about a token being held
// and about a refund. (Found live on 25 Oct 2026: after a ₹50,000 token and a buyer cancel, admin and partner got nothing, and the
// buyer's refund text had no amount.)
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  escrowTransaction: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
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
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const svc = require('../../src/modules/escrow/escrow.service');

const SETTINGS = jest.requireActual('../../src/modules/money/moneyConfig').parseSettings([]);
const flush = () => new Promise((r) => setImmediate(r));
const forUser = (id) => createNotification.mock.calls.map((c) => c[0]).filter((n) => n.userId === id);

beforeEach(() => {
  jest.resetAllMocks();
  createNotification.mockResolvedValue();
  notifyAdmins.mockResolvedValue();
  getMoneySettings.mockResolvedValue(SETTINGS);
  prisma.user.findUnique.mockResolvedValue(null);
});

describe('token paid', () => {
  const pending = { id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status: 'PAYMENT_PENDING', amount: 50000, chargedPaise: 5_120_900, processingFeePaise: 120_900 };
  const paid = async (lead) => {
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(pending).mockResolvedValue({ ...pending, status: 'HELD', razorpayPaymentId: 'pay_1' });
    rz.razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_1', status: 'captured', amount: 5_120_900, currency: 'INR' });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.lead.findUnique.mockResolvedValue(lead);
    await svc.confirmPayment('order_1', 'pay_1', 'b1');
    await flush();
  };

  test('the assigned partner and the admins are told, even when the partner also owns the listing', async () => {
    await paid({ refCode: 'RD-L-000103', assignedPartnerId: 'p1', property: { id: 'pr1', title: 'Vrunda City', partnerId: 'p1' } });
    const toPartner = forUser('p1');
    expect(toPartner).toHaveLength(1);
    expect(toPartner[0]).toMatchObject({ type: 'ESCROW_HELD', linkUrl: '/partners/leads/l1' });
    expect(toPartner[0].message).toContain('RD-L-000103');
    expect(toPartner[0].message).toContain('₹50,000');
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'ESCROW_HELD', linkUrl: '/admin/escrow' }));
    expect(notifyAdmins.mock.calls[0][0].message).toContain('RD-L-000103');
    expect(forUser('b1')).toHaveLength(1);
  });

  test('a listing owner who is not the assigned partner is told as before, in addition', async () => {
    await paid({ refCode: 'RD-L-000104', assignedPartnerId: 'p1', property: { id: 'pr1', title: 'Villa', partnerId: 'owner9' } });
    expect(forUser('p1')).toHaveLength(1);
    expect(forUser('owner9')).toHaveLength(1);
    expect(forUser('owner9')[0].title).toBe('Token received on your listing');
  });

  test('no assigned partner: only the buyer and the admins are told', async () => {
    await paid({ refCode: 'RD-L-000105', assignedPartnerId: null, property: { id: 'pr1', title: 'Villa', partnerId: null } });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
});

describe('refund', () => {
  const held = (extra = {}) => ({ id: 'e1', status: 'HELD', buyerId: 'b1', leadId: 'l1', amount: 50000, processingFeePaise: 120_900, razorpayPaymentId: 'pay_1', heldAt: new Date(), ...extra });
  const refundIt = async (opts, escrow = held()) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow);
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: null, allocationLetterVerifiedAt: null, refCode: 'RD-L-000103', assignedPartnerId: 'p1', property: { title: 'Vrunda City' } });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'e1', ...data }));
    rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
    await svc.refund('e1', opts.adminId ?? null, 'ip', opts.o);
    await flush();
  };

  test('buyer cancel inside the window: the buyer is told the amount and that the fee is kept; the partner and admins are told', async () => {
    await refundIt({ o: { reason: 'BUYER_CANCEL', actorType: 'BUYER' } });
    const b = forUser('b1')[0];
    expect(b.title).toBe('Escrow Refunded');
    expect(b.message).toContain('₹50,000');
    expect(b.message).toMatch(/processing fee/i);
    const p = forUser('p1')[0];
    expect(p).toMatchObject({ type: 'ESCROW_REFUNDED' });
    expect(p.message).toContain('RD-L-000103');
    expect(p.message).toContain('₹50,000');
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'ESCROW_REFUNDED', linkUrl: '/admin/escrow' }));
  });

  test('buyer cancel after the window: the buyer, partner and admins all hear the charge', async () => {
    await refundIt({ o: { reason: 'BUYER_CANCEL', actorType: 'BUYER' } }, held({ heldAt: new Date(Date.now() - 100 * 3600e3) }));
    expect(forUser('b1')[0].message).toContain('₹47,001');
    expect(forUser('b1')[0].message).toContain('₹2,999');
    expect(forUser('p1')[0].message).toContain('₹2,999');
    expect(notifyAdmins.mock.calls[0][0].message).toContain('₹2,999');
  });

  test('an admin token-only refund also tells the partner and the other admins', async () => {
    await refundIt({ adminId: 'a1', o: { reason: 'ADMIN_TOKEN_ONLY', actorType: 'ADMIN' } });
    expect(forUser('p1')).toHaveLength(1);
    expect(forUser('b1')[0].message).toContain('₹50,000');
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
});
