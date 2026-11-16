// Audit of November 2026, phase 1 (money). Each test states the behaviour we want. They were written as test.failing while the
// bugs were open and became plain tests on 10 Nov 2026 when the fixes went in. Finding numbers match
// admin-nextjs/docs/AUDIT_2026-11.md. More F1 cases (retry, refund the rest, mark settled): audit2026_11_payoutUnknown.test.js.

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/lib/prisma', () => {
  const m = () => ({ findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn(), count: jest.fn() });
  return {
    lead: m(), user: m(), platformConfig: m(), escrowTransaction: m(), leadCommissionLine: m(), tdsEntry: m(), userSubscription: m(),
    partnerTaxInvoice: m(), commissionVoucher: m(), moneyLedgerEntry: m(), auditLog: m(), counter: m(),
  };
});
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/wati', () => ({ sendVoucherOtp: jest.fn(), notifyUser: jest.fn(), sendPhoneVerificationOtp: jest.fn() }));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: { orders: { fetchPayments: jest.fn() } }, createEscrowOrder: jest.fn(), createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(),
  createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(), refundPayment: jest.fn(), rawGet: jest.fn(), findPayoutByReference: jest.fn(),
}));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const escrow = require('../../src/modules/escrow/escrow.service');
const payouts = require('../../src/modules/escrow/escrowPayout.service');

const SELLER = { name: 'Seller', email: 's@x.in', phone: '9999999999', ifsc: 'HDFC0001234', accountNumber: '123456789012' };
const ledgerRows = () => prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  jest.resetAllMocks();
  const n = require('../../src/lib/notifications');
  n.createNotification.mockResolvedValue({}); n.notifyAdmins.mockResolvedValue({}); n.broadcastNotification.mockResolvedValue({});
  prisma.platformConfig.findMany.mockResolvedValue([]);
  prisma.platformConfig.findUnique.mockResolvedValue(null);
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockImplementation(async ({ data }) => ({ id: 'a1', ...data }));
  prisma.moneyLedgerEntry.findUnique.mockResolvedValue(null);
  prisma.moneyLedgerEntry.create.mockImplementation(async ({ data }) => ({ id: `l${Math.random()}`, ...data }));
  prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'esc1', leadId: 'lead1', buyerId: 'b1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1', heldAt: new Date() });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'esc1', leadId: 'lead1', amount: 50000, ...data }));
  prisma.lead.findUnique.mockResolvedValue({
    id: 'lead1', refCode: 'RD1', feePct: 2, dealPriceAtLock: 7500000, commissionLockedAt: new Date(), commissionVersion: 1, allocationLetterUrl: 'x',
    allocationLetterVerifiedAt: new Date(), buyerFeedbackStatus: 'VERIFIED_CLOSED', status: 'SITE_VISIT_DONE', assignedPartnerId: 'p1',
    property: { price: 7500000, title: 'Plot' },
    assignedPartner: { id: 'p1', name: 'Asha', role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false, payoutAccountStatus: 'ACTIVE', razorpayFundAccountId: 'fa_1' },
  });
  prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50 }]);
  // An unregistered partner (no GSTIN): paid at release with a voucher, so the partner leg is not deferred.
  prisma.user.findUnique.mockResolvedValue({ id: 'p1', name: 'Asha', role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false, panNumber: 'ABCDE1234F', gstin: null, razorpayFundAccountId: 'fa_1', payoutAccountStatus: 'ACTIVE', billingAddress: 'x' });
  prisma.tdsEntry.findMany.mockResolvedValue([]);
  prisma.tdsEntry.findUnique.mockResolvedValue(null);
  prisma.tdsEntry.create.mockImplementation(async ({ data }) => ({ id: 't1', ...data }));
  prisma.partnerTaxInvoice.findFirst.mockResolvedValue(null);
  prisma.counter.upsert.mockResolvedValue({ seq: 12 });
  prisma.commissionVoucher.findUnique.mockResolvedValue(null);
  prisma.commissionVoucher.create.mockImplementation(async ({ data }) => ({ id: 'v1', ...data }));
  rz.createPayoutContact.mockResolvedValue({ id: 'c1' });
  rz.createPayoutFundAccount.mockResolvedValue({ id: 'fa_s' });
});

describe('F1: a payout request whose result is unknown', () => {
  test('a timeout while creating the seller payout must not put the escrow back to HELD (the payout may exist at RazorpayX; HELD lets it be refunded or released again)', async () => {
    // A network timeout: RazorpayX may or may not have created the payout. There is no statusCode, so nobody refused it.
    rz.createPayout.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    prisma.lead.findUnique.mockResolvedValue({ ...(await prisma.lead.findUnique()), assignedPartnerId: null, assignedPartner: null });
    prisma.leadCommissionLine.findMany.mockResolvedValue([]);
    await expect(escrow.release('esc1', 'admin1', { sellerDetails: SELLER }, '::1')).rejects.toMatchObject({ statusCode: 502 });
    const finalWrite = prisma.escrowTransaction.update.mock.calls.at(-1)[0].data;
    expect(finalWrite.status).not.toBe('HELD');
  });
});

describe('F20: the ledger when the seller leg fails and the partner leg pays', () => {
  test('no "paid outside Razorpay" seller row is written for a seller payout that failed', async () => {
    rz.createPayout.mockImplementation(async (fa, paise, ref) => {
      if (ref.startsWith('esc_s_')) throw { statusCode: 400, error: { description: 'beneficiary bank is down' } };
      return { id: 'pout_p', status: 'processing' };
    });
    await expect(escrow.release('esc1', 'admin1', { sellerDetails: SELLER }, '::1')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data.status).toBe('HELD_PAYOUT_FAILED');
    const sellerPaid = ledgerRows().filter((r) => r.type === 'SELLER_PAYOUT' && r.status === 'PAID');
    expect(sellerPaid).toEqual([]);
  });
});

describe('F3: a retried payout and the ledger', () => {
  test('a successful seller retry writes a ledger row that carries the new payout id (so its webhook can settle it)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({
      id: 'esc1', leadId: 'lead1', status: 'HELD_PAYOUT_FAILED', amount: 50000, razorpayPaymentId: 'pay_1', netAmount: 49000, partnerShareAmount: 0,
      razorpayPayoutId: 'pout_old', sellerPayoutStatus: 'failed', refundedAmountPaise: 0, payoutAttempt: 1,
    });
    rz.rawGet.mockResolvedValue({ status: 'failed' });
    rz.createPayout.mockResolvedValue({ id: 'pout_new', status: 'queued' });
    await payouts.retryPayout('esc1', { leg: 'seller', sellerDetails: SELLER }, 'admin1', '::1');
    expect(rz.createPayout).toHaveBeenCalledTimes(1);
    expect(ledgerRows().some((r) => r.razorpayPayoutId === 'pout_new')).toBe(true);
  });
});

describe('F7: tokens the hold-limit jobs never look at', () => {
  test('the hold-limit job also finds part-refunded and payout-failed tokens (they still hold buyer money)', async () => {
    jest.doMock('../../src/modules/config/config.service', () => ({ getConfigValue: jest.fn().mockResolvedValue('false'), getConfigNumber: jest.fn() }));
    prisma.escrowTransaction.findMany.mockResolvedValue([]);
    await require('../../src/jobs/escrowHoldExpiry').runOnce();
    const statuses = prisma.escrowTransaction.findMany.mock.calls[0][0].where.status.in;
    expect(statuses).toEqual(expect.arrayContaining(['PARTIALLY_REFUNDED', 'HELD_PAYOUT_FAILED']));
  });
});

describe('F27: a payout settled by the reconcile job', () => {
  test('when the job (not the webhook) sees a payout processed, the ledger gets the PAID row too', async () => {
    prisma.escrowTransaction.findMany.mockImplementation(async ({ where }) => (where.OR
      ? [{ id: 'esc1', leadId: 'lead1', status: 'RELEASED', razorpayPayoutId: 'pout_s', sellerPayoutStatus: 'processing', partnerPayoutStatus: null }]
      : []));
    prisma.userSubscription.findMany.mockResolvedValue([]);
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue({ id: 'due1', leadId: 'lead1', escrowId: 'esc1', type: 'SELLER_PAYOUT', direction: 'OUT', partyType: 'SELLER', grossPaise: 4900000, netPaise: 4900000, razorpayPayoutId: 'pout_s' });
    rz.rawGet.mockResolvedValue({ id: 'pout_s', status: 'processed', utr: 'UTR1' });
    const r = await require('../../src/jobs/paymentReconcile').runOnce();
    expect(r.reconciledPayouts).toBe(1);
    expect(ledgerRows().some((row) => row.status === 'PAID' && row.type === 'SELLER_PAYOUT')).toBe(true);
  });
});

describe('F1: release(), more cases', () => {
  const noPartner = async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...(await prisma.lead.findUnique()), assignedPartnerId: null, assignedPartner: null });
    prisma.leadCommissionLine.findMany.mockResolvedValue([]);
  };
  test('the unanswered seller leg is stored as "unconfirmed" on a payout-failed escrow', async () => {
    await noPartner();
    rz.createPayout.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(escrow.release('esc1', 'admin1', { sellerDetails: SELLER }, '::1')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'HELD_PAYOUT_FAILED', sellerPayoutStatus: 'unconfirmed' });
  });
  test('a clear refusal with nothing paid still goes back to HELD, as before (nothing was created)', async () => {
    await noPartner();
    rz.createPayout.mockRejectedValue({ statusCode: 400, error: { description: 'beneficiary bank is down' } });
    await expect(escrow.release('esc1', 'admin1', { sellerDetails: SELLER }, '::1')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data.status).toBe('HELD');
  });
});

describe('F1: "Pay partner" after an unanswered payout request', () => {
  const released = (over = {}) => ({ id: 'esc1', leadId: 'lead1', buyerId: 'b1', amount: 50000, status: 'RELEASED', partnerPayoutStatus: 'unconfirmed', payoutAttempt: 0, ...over });
  test('DOUBLE PAYMENT: the earlier payout is looked up by reference and reused; no second payout is created', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(released());
    rz.findPayoutByReference.mockResolvedValue({ id: 'pout_lost', status: 'processing', reference_id: 'esc_p_esc1_a0' });
    await escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1');
    expect(rz.findPayoutByReference).toHaveBeenCalledWith('esc_p_esc1_a0');
    expect(rz.createPayout).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.update.mock.calls.some((c) => c[0].data.razorpayPartnerPayoutId === 'pout_lost')).toBe(true);
  });
  test('RazorpayX cannot be asked: nothing is paid and the leg stays unconfirmed', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(released());
    rz.findPayoutByReference.mockRejectedValue(new Error('timeout'));
    await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ statusCode: 502 });
    expect(rz.createPayout).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data).toEqual({ partnerPayoutStatus: 'unconfirmed' });
  });
  test('a held (deferred) payout whose request times out becomes unconfirmed, not deferred (deferred would pay again)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(released({ partnerPayoutStatus: 'deferred' }));
    rz.createPayout.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ statusCode: 502, data: { code: 'PAYOUT_UNCONFIRMED' } });
    expect(rz.findPayoutByReference).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data.partnerPayoutStatus).toBe('unconfirmed');
  });
  test('a clear refusal puts it back to deferred', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(released({ partnerPayoutStatus: 'deferred' }));
    rz.createPayout.mockRejectedValue({ statusCode: 400, error: { description: 'insufficient balance' } });
    await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ statusCode: 502, data: { code: 'RAZORPAYX_ERROR' } });
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data).toEqual({ partnerPayoutStatus: 'deferred' });
  });
});

describe('F1 and F2: the reconcile job', () => {
  const job = () => require('../../src/jobs/paymentReconcile');
  const { notifyAdmins } = require('../../src/lib/notifications');
  const OLD = new Date(Date.now() - 60 * 60 * 1000);
  const stuck = { id: 'esc1', leadId: 'lead1', status: 'HELD_PAYOUT_FAILED', amount: 50000, sellerPayoutStatus: 'unconfirmed', payoutAttempt: 0, updatedAt: OLD };

  test('an unconfirmed payout that RazorpayX does not have is marked failed and the admins are told', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([stuck]);
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(stuck).mockResolvedValueOnce({ ...stuck, sellerPayoutStatus: 'failed' });
    rz.findPayoutByReference.mockResolvedValue(null);
    expect(await job().reconcileUnconfirmedPayouts()).toBe(1);
    expect(rz.findPayoutByReference).toHaveBeenCalledTimes(1);
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'esc1', sellerPayoutStatus: 'unconfirmed' }, data: { sellerPayoutStatus: 'failed' } });
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
  test('one that RazorpayX does have is recorded and the escrow goes back to RELEASED', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([stuck]);
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(stuck).mockResolvedValueOnce({ ...stuck, status: 'RELEASED', sellerPayoutStatus: 'processing', razorpayPayoutId: 'pout_lost' });
    rz.findPayoutByReference.mockResolvedValue({ id: 'pout_lost', status: 'processing', amount: 4900000, reference_id: 'esc_s_esc1_a0' });
    expect(await job().reconcileUnconfirmedPayouts()).toBe(1);
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ razorpayPayoutId: 'pout_lost', status: 'RELEASED' });
    expect(ledgerRows().some((r) => r.razorpayPayoutId === 'pout_lost')).toBe(true);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
  test('RazorpayX unreachable: nothing changes, it is tried again on the next run', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([stuck]);
    prisma.escrowTransaction.findUnique.mockResolvedValue(stuck);
    rz.findPayoutByReference.mockRejectedValue(new Error('timeout'));
    expect(await job().reconcileUnconfirmedPayouts()).toBe(0);
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  describe('F2: a row that says money moved when the app never finished moving it', () => {
    const rows = {
      refunded: [{ id: 'r1', status: 'REFUNDED', amount: 50000, refundIds: [] }],
      released: [
        { id: 'manual1', status: 'RELEASED', amount: 50000 },                              // a confirmed manual transfer: has its audit entry
        { id: 'rel1', status: 'RELEASED', amount: 50000 },                                 // release() died after the claim
        { id: 'attempted', status: 'RELEASED', amount: 50000, sellerPayoutStatus: 'failed' }, // a payout was tried; other alerts cover it
      ],
      partner: [{ id: 'p1', status: 'RELEASED', amount: 50000, partnerPayoutStatus: 'claiming' }],
    };
    const wire = (alreadyAlerted = false) => {
      prisma.escrowTransaction.findMany.mockImplementation(async ({ where }) => {
        if (where.status === 'REFUNDED') return rows.refunded;
        if (where.partnerPayoutStatus) return rows.partner.map((r) => ({ ...r }));
        return rows.released;
      });
      prisma.auditLog.findFirst.mockImplementation(async ({ where }) => {
        if (where.action === 'ESCROW_RELEASED') return where.targetId === 'manual1' ? { id: 'a' } : null;
        return alreadyAlerted ? { id: 'b' } : null;
      });
    };
    test('each kind is reported once: refund not sent, release not paid, partner payout stuck', async () => {
      wire();
      expect(await job().alertStuckMoneyStates()).toBe(3);
      expect(notifyAdmins.mock.calls.map((c) => c[0].title)).toEqual(['Refund marked but not sent', 'Release marked but no payout made', 'Partner payout needs a check']);
      const alerts = prisma.auditLog.create.mock.calls.map((c) => [c[0].data.action, c[0].data.targetId]);
      expect(alerts).toEqual([['ALERT_REFUND_NOT_SENT', 'r1'], ['ALERT_RELEASE_NOT_PAID', 'rel1'], ['ALERT_PARTNER_PAYOUT_STUCK', 'p1']]);
      // the stuck "claiming" payout is made payable again, through the lookup-first path
      expect(prisma.escrowTransaction.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'p1', partnerPayoutStatus: 'claiming' }, data: { partnerPayoutStatus: 'unconfirmed' } });
      // no money call of any kind
      expect(rz.createPayout).not.toHaveBeenCalled();
      expect(rz.refundPayment).not.toHaveBeenCalled();
    });
    test('the next run does not report them again', async () => {
      wire(true);
      prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
      expect(await job().alertStuckMoneyStates()).toBe(0);
      expect(notifyAdmins).not.toHaveBeenCalled();
    });
    test('a failure in these checks never stops the rest of the job', async () => {
      prisma.escrowTransaction.findMany.mockImplementation(async ({ where }) => { if (where.status === 'REFUNDED') throw new Error('db down'); return []; });
      prisma.userSubscription.findMany.mockResolvedValue([]);
      await expect(job().runOnce()).resolves.toMatchObject({ healedEscrows: 0, stuckAlerts: 0 });
    });
  });
});
