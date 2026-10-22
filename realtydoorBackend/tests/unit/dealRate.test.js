// "Change the rate on this one deal" (money model Rev 3): partner % + platform % of the deal price, through setLeadTerms.

jest.mock('../../src/lib/prisma', () => ({ lead: { findUnique: jest.fn() }, platformConfig: { findMany: jest.fn(), findUnique: jest.fn() } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn() }));
jest.mock('../../src/modules/listings/integrity.service', () => ({ isSelfListedByAgent: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/modules/referrals/referral.service', () => ({ getActiveReferralForPhone: jest.fn().mockResolvedValue(null) }));

const prisma = require('../../src/lib/prisma');
const { createNotification } = require('../../src/lib/notifications');
const commission = require('../../src/modules/commission/commission.service');
const { dealRateSchema } = require('../../src/modules/commission/commission.validator');

const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', assignedPartnerId: 'p1', commissionLockedAt: null, commissionStatus: 'PENDING', partnerRatePct: 1, escrowTransactions: [], ...over });
let setTerms;

beforeEach(() => {
  jest.resetAllMocks();
  createNotification.mockResolvedValue({});
  prisma.platformConfig.findMany.mockResolvedValue([]); // defaults: 1% + 1%
  prisma.platformConfig.findUnique.mockResolvedValue(null);
  setTerms = jest.spyOn(commission, 'setLeadTerms').mockResolvedValue({ locked: false });
});
afterEach(() => setTerms.mockRestore());

describe('setDealRate', () => {
  test('1.5% + 1% becomes feePct 2.5 with the partner holding 60% of the fee, as a DEAL rate with its reason', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await commission.setDealRate('l1', { partnerRatePct: 1.5, platformFeePct: 1, reason: 'Builder asked for more' }, 'a1', '1.1.1.1');
    expect(setTerms).toHaveBeenCalledWith('l1', {
      feePct: 2.5, lines: [{ payeeRole: 'CLOSING_AGENT', pct: 60 }], note: 'Builder asked for more',
      rateMeta: { source: 'DEAL', reason: 'Builder asked for more' },
    }, 'a1', '1.1.1.1');
  });
  test('the standard rate needs no reason', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await commission.setDealRate('l1', { partnerRatePct: 1 }, 'a1');
    expect(setTerms.mock.calls[0][1]).toMatchObject({ feePct: 2, lines: [{ payeeRole: 'CLOSING_AGENT', pct: 50 }] });
  });
  test('a different rate without a reason is refused', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await expect(commission.setDealRate('l1', { partnerRatePct: 1.5 }, 'a1')).rejects.toMatchObject({ statusCode: 400, data: expect.objectContaining({ code: 'RATE_REASON_REQUIRED' }) });
    await expect(commission.setDealRate('l1', { partnerRatePct: 1.5, reason: 'ok' }, 'a1')).rejects.toMatchObject({ statusCode: 400 });
    expect(setTerms).not.toHaveBeenCalled();
  });
  test('needs an assigned partner', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ assignedPartnerId: null }));
    await expect(commission.setDealRate('l1', { partnerRatePct: 1 }, 'a1')).rejects.toMatchObject({ data: expect.objectContaining({ code: 'NO_ASSIGNED_PARTNER' }) });
  });
  test.each([
    ['token released', { escrowTransactions: [{ status: 'RELEASED' }] }],
    ['brokerage invoiced', { commissionStatus: 'INVOICED' }],
    ['brokerage collected', { commissionStatus: 'COLLECTED' }],
  ])('is frozen once the money has moved (%s)', async (_n, over) => {
    prisma.lead.findUnique.mockResolvedValue(lead(over));
    await expect(commission.setDealRate('l1', { partnerRatePct: 1 }, 'a1')).rejects.toMatchObject({ statusCode: 409, data: expect.objectContaining({ code: 'DEAL_RATE_FROZEN' }) });
    expect(setTerms).not.toHaveBeenCalled();
  });
  test('a partner who had already seen a locked rate is told it changed', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ commissionLockedAt: new Date(), partnerRatePct: 1 }));
    await commission.setDealRate('l1', { partnerRatePct: 2, reason: 'Negotiated up' }, 'a1');
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1', type: 'COMMISSION_RATE_CHANGED', message: expect.stringContaining('2%') }));
  });
  test('no notice before the partner has seen a locked rate, or when the rate did not change', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await commission.setDealRate('l1', { partnerRatePct: 1 }, 'a1');
    prisma.lead.findUnique.mockResolvedValue(lead({ commissionLockedAt: new Date(), partnerRatePct: 1 }));
    await commission.setDealRate('l1', { partnerRatePct: 1 }, 'a1');
    expect(createNotification).not.toHaveBeenCalled();
  });
  test('unknown lead is a 404', async () => {
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(commission.setDealRate('nope', { partnerRatePct: 1 }, 'a1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('dealRateSchema', () => {
  test('partner rate above 0 and up to 20, platform fee 0 to 20', () => {
    expect(dealRateSchema.safeParse({ partnerRatePct: 1 }).success).toBe(true);
    expect(dealRateSchema.safeParse({ partnerRatePct: 0 }).success).toBe(false);
    expect(dealRateSchema.safeParse({ partnerRatePct: 21 }).success).toBe(false);
    expect(dealRateSchema.safeParse({ partnerRatePct: 1, platformFeePct: -1 }).success).toBe(false);
    expect(dealRateSchema.safeParse({ partnerRatePct: 1, platformFeePct: 0 }).success).toBe(true);
  });
});
