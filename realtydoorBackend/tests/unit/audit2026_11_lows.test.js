// Audit Nov 2026: the Low findings of the money phase (F6, F9, F10, F12, F14, F15, F16, F22, F24, F25) and the rest of F19.
jest.mock('../../src/lib/prisma', () => {
  const models = {};
  return new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || model === '__esModule' || model === 'then') return undefined;
      if (model.startsWith('$')) { models[model] = models[model] || jest.fn(); return models[model]; }
      models[model] = models[model] || new Proxy({}, { get(m, fn) { if (typeof fn !== 'string') return undefined; m[fn] = m[fn] || jest.fn(); return m[fn]; } });
      return models[model];
    },
  });
});
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn(), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: { orders: { fetch: jest.fn(), fetchPayments: jest.fn() }, payments: { fetch: jest.fn() } },
  createOrder: jest.fn(), createEscrowOrder: jest.fn(), refundPayment: jest.fn(),
}));
jest.mock('../../src/modules/money/ledger.service', () => ({ onTdsDeposited: jest.fn() }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/lib/prisma');
const notifications = require('../../src/lib/notifications');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

beforeEach(() => {
  jest.resetAllMocks();
  notifications.notifyAdmins.mockResolvedValue({});
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue({});
  prisma.counter.create.mockResolvedValue({});
  prisma.counter.deleteMany.mockResolvedValue({});
});

describe('F6: a captured payment that does not match its order is never confirmed', () => {
  const escrow = { id: 'e1', razorpayOrderId: 'o1', status: 'PAYMENT_PENDING', amount: 50000, chargedPaise: 5120900 };
  test('the escrow webhook path', async () => {
    const svc = require('../../src/modules/escrow/escrow.service');
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow);
    const r = await svc.confirmPayment('o1', 'p1', null, { amount: 100, currency: 'INR' });
    expect(r).toBe(escrow);
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyAdmins).toHaveBeenCalled();
  });
  test('a wrong currency is refused the same way', async () => {
    const svc = require('../../src/modules/escrow/escrow.service');
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow);
    await svc.confirmPayment('o1', 'p1', null, { amount: 5120900, currency: 'USD' });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('the right amount passes the check and goes on to the claim', async () => {
    const svc = require('../../src/modules/escrow/escrow.service');
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow);
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await svc.confirmPayment('o1', 'p1', null, { amount: 5120900, currency: 'INR' }).catch(() => null);
    expect(prisma.escrowTransaction.updateMany).toHaveBeenCalled();
  });
  test('the service plan webhook path', async () => {
    const svc = require('../../src/modules/services/services.service');
    prisma.userSubscription.findUnique.mockResolvedValue({ id: 's1', paymentStatus: 'PENDING', amountPaid: 999, amountPaidPaise: 99900 });
    const r = await svc.activateSubscription('o', 'p', null, { amount: 1, currency: 'INR' });
    expect(r.paymentStatus).toBe('PENDING');
    expect(prisma.userSubscription.updateMany).not.toHaveBeenCalled();
  });
});

describe('F9, F10: order race and bank details', () => {
  const { releaseEscrowSchema } = require('../../src/modules/escrow/escrow.validator');
  const bank = (over) => ({ name: 'S', phone: '+919876543210', ifsc: 'HDFC0001234', accountNumber: '123456789012', ...over });
  test('a bank account number is 9 to 18 digits', () => {
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ accountNumber: '1' }) }).success).toBe(false);
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ accountNumber: '12345678' }) }).success).toBe(false);
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ accountNumber: '123456789012345678' }) }).success).toBe(true);
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ accountNumber: '1234567890123456789' }) }).success).toBe(false);
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ accountNumber: '12345abc9' }) }).success).toBe(false);
  });
  test('the seller email is optional but must be an email when given', () => {
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank() }).success).toBe(true);
    expect(releaseEscrowSchema.safeParse({ sellerDetails: bank({ email: 'nope' }) }).success).toBe(false);
  });
});

describe('F12, F14, F16, F22: escrow service source rules', () => {
  const s = src('modules/escrow/escrow.service.js');
  test('the release rollback to HELD clears the saved split', () => {
    expect(s).toMatch(/status: 'HELD', releasedAt: null, releasedByAdminId: null,\s+netAmount: null/);
  });
  test('a refund of nothing is refused before the claim', () => {
    expect(s).toMatch(/NOTHING_TO_REFUND/);
  });
  test('the stats read the refunded paise and a bounded number of releases', () => {
    expect(s).toMatch(/refundedAmountPaise: true \} \}\),/);
    expect(s).toMatch(/take: 500/);
  });
  test('Razorpay calls have a timeout', () => {
    expect(src('lib/razorpay.js')).toMatch(/defaults\.timeout/);
  });
});

describe('F15: a lock cleanup never deletes someone else’s lock', () => {
  test('the delete names the time this holder wrote', async () => {
    const { withKeyLock } = require('../../src/lib/keyLock');
    await withKeyLock('k', async () => 1);
    const where = prisma.counter.deleteMany.mock.calls[0][0].where;
    expect(where.id).toBe('lock:k');
    expect(typeof where.seq).toBe('number');
  });
});

describe('F24: bulk TDS updates check every id before writing', () => {
  const tds = require('../../src/modules/money/tds.service');
  test('deposit: a bad second id writes nothing', async () => {
    prisma.tdsEntry.findUnique.mockResolvedValueOnce({ id: 'a', tdsPaise: 100 }).mockResolvedValueOnce(null);
    await expect(tds.recordDeposit(['a', 'b'], { challanNumber: 'c', bsrCode: 'b' }, 'ad', null)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.tdsEntry.update).not.toHaveBeenCalled();
  });
  test('return and Form 16A: same', async () => {
    prisma.tdsEntry.findUnique.mockResolvedValueOnce({ id: 'a', tdsPaise: 0 }).mockResolvedValueOnce(null);
    await expect(tds.recordReturn(['a', 'b'], { returnQuarter: 'Q1' }, 'ad', null)).rejects.toMatchObject({ statusCode: 404 });
    prisma.tdsEntry.findUnique.mockResolvedValueOnce({ id: 'a', tdsPaise: 0 }).mockResolvedValueOnce(null);
    await expect(tds.recordForm16a(['a', 'b'], {}, 'ad', null)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.tdsEntry.update).not.toHaveBeenCalled();
  });
});

describe('F25: money settings', () => {
  const { parseSettings } = require('../../src/modules/money/moneyConfig');
  test('a blank value means the default, not zero', () => {
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '' }]).commission.partnerRatePct).toBe(1);
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '  ' }]).commission.partnerRatePct).toBe(1);
  });
  test('a negative number or a percentage above 100 is ignored', () => {
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '-5' }]).commission.partnerRatePct).toBe(1);
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '150' }]).commission.partnerRatePct).toBe(1);
  });
  test('a real value is used, including an honest zero', () => {
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '2.5' }]).commission.partnerRatePct).toBe(2.5);
    expect(parseSettings([{ key: 'default_partner_rate_pct', value: '0' }]).commission.partnerRatePct).toBe(0);
  });
});

describe('F19: roles', () => {
  const r = src('modules/admin/admin.routes.js');
  test('a read-only finance role cannot change a dispute but can read payout history', () => {
    expect(r).toMatch(/router\.patch\('\/disputes\/:id', requirePermission\(\['TICKETS', 'FINANCE'\]\)/);
    expect(r).toMatch(/\/escrow\/:id\/payouts',\s+requirePermission\(\['FINANCE', 'FINANCE_VIEW'\]\)/);
  });
});

describe('A7: an outage is not a bad token', () => {
  test('a database error while signing someone in is a 503, a token that does not verify stays 401', async () => {
    jest.resetModules();
    const verify = jest.fn();
    jest.doMock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => ({ verifyToken: verify, users: { getUser: jest.fn() } }) }));
    jest.doMock('../../src/modules/auth/auth.service', () => ({ syncUserByClerkId: jest.fn() }));
    const p = require('../../src/lib/prisma');
    const { authenticate } = require('../../src/middleware/auth');
    const run = async () => { const next = jest.fn(); await authenticate({ headers: { authorization: 'Bearer x' }, originalUrl: '/api/x', method: 'GET' }, {}, next); return next.mock.calls[0][0]; };
    verify.mockRejectedValue(new Error('bad signature'));
    expect(await run()).toMatchObject({ statusCode: 401 });
    verify.mockResolvedValue({ sub: 'c1' });
    p.user.findUnique.mockRejectedValue(new Error('mongo down'));
    expect(await run()).toMatchObject({ statusCode: 503, data: { code: 'SERVICE_UNAVAILABLE' } });
  });
});
