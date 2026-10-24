// Service-level checks for money model Rev 3 with Prisma mocked (no database).

jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  rateCard: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  partnerCommissionOverride: { findMany: jest.fn() },
  platformConfig: { findMany: jest.fn(), findUnique: jest.fn() },
  project: { findUnique: jest.fn() },
  escrowTransaction: { findUnique: jest.fn() },
  leadCommissionLine: { findMany: jest.fn() },
  tdsEntry: { findMany: jest.fn() },
  partnerTaxInvoice: { findFirst: jest.fn() },
  moneyLedgerEntry: { findUnique: jest.fn(), create: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/modules/listings/integrity.service', () => ({ isSelfListedByAgent: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/modules/referrals/referral.service', () => ({ getActiveReferralForPhone: jest.fn().mockResolvedValue(null) }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const commission = require('../../src/modules/commission/commission.service');
const escrow = require('../../src/modules/escrow/escrow.service');

const lead = (over = {}) => ({
  id: 'lead1', assignedPartnerId: 'p1', propertyId: 'prop1', buyerPhone: '9', city: 'Bengaluru',
  property: { id: 'prop1', city: 'Bengaluru', price: 7500000, partnerId: 'owner1', projectId: 'proj1' },
  ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  require('../../src/modules/listings/integrity.service').isSelfListedByAgent.mockResolvedValue(false);
  require('../../src/modules/referrals/referral.service').getActiveReferralForPhone.mockResolvedValue(null);
  prisma.platformConfig.findMany.mockResolvedValue([]); // every setting at its default
  prisma.platformConfig.findUnique.mockResolvedValue(null);
  prisma.user.findUnique.mockResolvedValue({ partnerSubType: 'BUILDER' });
  prisma.rateCard.findFirst.mockResolvedValue(null);
  prisma.partnerCommissionOverride.findMany.mockResolvedValue([]);
});

describe('previewTermsForLead: rate resolution', () => {
  test('no card, no override: platform default 1% + 1%, partner takes half of the 2% fee', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    const p = await commission.previewTermsForLead('lead1');
    expect(p.feePct).toBe(2);
    expect(p.lines).toEqual([{ payeeRole: 'CLOSING_AGENT', pct: 50 }]);
    expect(p.rate).toMatchObject({ source: 'PLATFORM_DEFAULT', partnerRatePct: 1, platformFeePct: 1, isCustom: false });
    expect(p.feeAmount).toBe(150000);
    expect(p.headroom).toBe(75000); // fee 1,50,000 less the partner 75,000 = Realtydoor platform fee
  });

  test('a project rate card wins over property and city cards, and is looked up through Property.projectId', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    prisma.rateCard.findFirst.mockImplementation(async ({ where }) => (where.projectId === 'proj1'
      ? { id: 'rc1', version: 3, feePct: 3.5, partnerRatePct: 2.5, platformFeePct: 1, isCustom: true, customReason: 'Launch push',
          lines: [{ payeeRole: 'CLOSING_AGENT', pct: (2.5 / 3.5) * 100 }] }
      : null));
    const p = await commission.previewTermsForLead('lead1');
    expect(p.rate).toMatchObject({ source: 'PROJECT', partnerRatePct: 2.5, platformFeePct: 1, isCustom: true, reason: 'Launch push' });
    expect(p.feeAmount).toBe(262500);
    expect(p.headroom).toBe(75000); // 2,62,500 less partner 1,87,500
    expect(p.rateCardId).toBe('rc1');
  });

  test('an older property card (no partnerRatePct) still gives a rate: fee % x partner lines', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ property: { id: 'prop1', city: 'B', price: 1000000, partnerId: 'o', projectId: null } }));
    prisma.rateCard.findFirst.mockImplementation(async ({ where }) => (where.propertyId === 'prop1'
      ? { id: 'rc2', version: 1, feePct: 2, lines: [{ payeeRole: 'CLOSING_AGENT', pct: 60 }] } : null));
    const p = await commission.previewTermsForLead('lead1');
    expect(p.rate).toMatchObject({ source: 'PROPERTY', partnerRatePct: 1.2, platformFeePct: 0.8 });
  });

  test('a partner override beats the project rate and is labelled', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    prisma.rateCard.findFirst.mockResolvedValue({
      id: 'rc1', version: 1, feePct: 3.5, partnerRatePct: 2.5, platformFeePct: 1, lines: [{ payeeRole: 'CLOSING_AGENT', pct: (2.5 / 3.5) * 100 }],
    });
    prisma.partnerCommissionOverride.findMany.mockResolvedValue([{ id: 'ov1', scope: 'ALL', propertyIds: [], partnerSharePct: 80, reason: 'Top performer' }]);
    const p = await commission.previewTermsForLead('lead1');
    expect(p.rate).toMatchObject({ source: 'PARTNER_OVERRIDE', partnerRatePct: 2.8, isCustom: true, reason: 'Top performer' });
  });
});

describe('setProjectRate', () => {
  test('a rate other than the default needs a reason', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj1', title: 'Green Meadows' });
    await expect(commission.setProjectRate('proj1', { partnerRatePct: 2.5 }, 'admin1', '::1'))
      .rejects.toMatchObject({ statusCode: 400, data: { code: 'CUSTOM_RATE_REASON_REQUIRED' } });
    expect(prisma.rateCard.create).not.toHaveBeenCalled();
  });

  test('creates a Custom card with a derived partner line and an audit entry', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj1', title: 'Green Meadows' });
    prisma.rateCard.create.mockImplementation(async ({ data }) => ({ id: 'rc9', version: 1, ...data }));
    await commission.setProjectRate('proj1', { partnerRatePct: 2.5, reason: 'Launch push' }, 'admin1', '::1');
    const { data } = prisma.rateCard.create.mock.calls[0][0];
    expect(data).toMatchObject({ projectId: 'proj1', feePct: 3.5, partnerRatePct: 2.5, platformFeePct: 1, isCustom: true, customReason: 'Launch push' });
    expect(data.lines.create[0].pct).toBeCloseTo(71.4286, 3);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PROJECT_COMMISSION_RATE_SET', targetId: 'proj1',
      after: expect.objectContaining({ partnerRatePct: 2.5, isCustom: true, reason: 'Launch push' }),
    }));
  });

  test('the default rate needs no reason and is not Custom; an existing card is versioned up', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj1', title: 'x' });
    prisma.rateCard.findFirst.mockResolvedValue({ id: 'rc1', version: 4, partnerRatePct: 2.5, platformFeePct: 1, lines: [] });
    prisma.rateCard.update.mockImplementation(async ({ data }) => ({ id: 'rc1', ...data }));
    await commission.setProjectRate('proj1', { partnerRatePct: 1 }, 'admin1', '::1');
    const { data } = prisma.rateCard.update.mock.calls[0][0];
    expect(data).toMatchObject({ isCustom: false, customReason: null, version: 5, feePct: 2 });
  });

  test('unknown project', async () => {
    prisma.project.findUnique.mockResolvedValue(null);
    await expect(commission.setProjectRate('nope', { partnerRatePct: 1 }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('escrow release plan: partner commission with TDS', () => {
  const planFor = async ({ partner, entries = [], settings = [] }) => {
    prisma.platformConfig.findMany.mockResolvedValue(settings);
    prisma.escrowTransaction.findUnique.mockResolvedValue({
      id: 'esc1', leadId: 'lead1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1',
    });
    prisma.lead.findUnique.mockResolvedValue({
      id: 'lead1', refCode: 'RD1', feePct: 2, dealPriceAtLock: 7500000, commissionLockedAt: new Date(), commissionVersion: 1,
      allocationLetterUrl: 'x', buyerFeedbackStatus: 'VERIFIED_CLOSED', status: 'SITE_VISIT_DONE',
      assignedPartnerId: 'p1', property: { price: 7500000 },
      assignedPartner: { id: 'p1', name: 'Asha', payoutAccountStatus: 'ACTIVE', razorpayFundAccountId: 'fa_1' },
    });
    prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50 }]);
    prisma.user.findUnique.mockResolvedValue(partner);
    prisma.tdsEntry.findMany.mockResolvedValue(entries);
    return escrow.getReleasePlan('esc1');
  };

  test('Rs 75 L deal, partner with PAN, not GST registered: commission 75,000, TDS 1,500, pays 73,500; seller gets the whole token', async () => {
    const plan = await planFor({ partner: { id: 'p1', name: 'Asha', panNumber: 'ABCDE1234F', gstin: null } });
    expect(plan.partnerPayout).toMatchObject({
      commissionPaise: 7500000, tdsPaise: 150000, payNowPaise: 7350000, gstPaise: 0,
      documentType: 'COMMISSION_VOUCHER', panOnFile: true, tdsRatePct: 2, blocked: false,
    });
    expect(plan.partnerShareAmount).toBe(73500);
    expect(plan.platformFeeAmount).toBe(0); // no fee taken from the token
    expect(plan.headroom).toBe(50000);
  });

  test('GST-registered partner: GST 13,500 is pending, not in the amount paid now', async () => {
    const plan = await planFor({ partner: { id: 'p1', name: 'Asha', panNumber: 'ABCDE1234F', gstin: '29ABCDE1234F1Z5' } });
    expect(plan.partnerPayout).toMatchObject({ payNowPaise: 7350000, gstPendingPaise: 1350000, documentType: 'TAX_INVOICE', taxInvoiceStatus: 'NOT_UPLOADED', payoutBlockedReason: 'TAX_INVOICE_REQUIRED' });
    expect(plan.conditions.find((c) => c.key === 'PARTNER_TAX_INVOICE')).toMatchObject({ ok: false, blocking: false });
  });

  test('no PAN: 20% by default, or refused when settings say BLOCK', async () => {
    const noPan = { id: 'p1', name: 'Asha', panNumber: null, gstin: null };
    const deduct = await planFor({ partner: noPan });
    expect(deduct.partnerPayout).toMatchObject({ tdsPaise: 1500000, tdsRateReason: 'NO_PAN', panOnFile: false, blocked: false });
    const block = await planFor({ partner: noPan, settings: [{ key: 'tds_missing_pan_action', value: 'BLOCK' }] });
    expect(block.partnerPayout).toMatchObject({ blocked: true, blockReason: 'PAN_REQUIRED' });
  });

  test('earlier commission this year counts towards the threshold', async () => {
    const plan = await planFor({
      partner: { id: 'p1', name: 'Asha', panNumber: 'ABCDE1234F', gstin: null },
      entries: [{ commissionBasePaise: 1500000, taxedBasePaise: 0 }], // 15,000 earlier, below the limit, nothing taxed
    });
    // 15,000 + 75,000 = 90,000 taxed in full at 2% = 1,800 (not 1,500)
    expect(plan.partnerPayout).toMatchObject({ tdsPaise: 180000, taxedBasePaise: 9000000, ytdBeforePaise: 1500000 });
  });

  test('no locked lines for the partner: no commission payout (old behaviour)', async () => {
    prisma.platformConfig.findMany.mockResolvedValue([]);
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'esc1', leadId: 'lead1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1' });
    prisma.lead.findUnique.mockResolvedValue({
      id: 'lead1', feePct: null, dealPriceAtLock: null, commissionLockedAt: null, commissionVersion: 1,
      assignedPartnerId: 'p1', property: { price: 7500000 }, assignedPartner: null,
    });
    const plan = await escrow.getReleasePlan('esc1');
    expect(plan.partnerPayout).toBeNull();
    expect(plan.partnerShareAmount).toBe(0);
  });
});

describe('BUG-049: release readiness needs the allocation letter VERIFIED, not only on file', () => {
  const planWith = async (letter) => {
    prisma.platformConfig.findMany.mockResolvedValue([]);
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'esc1', leadId: 'lead1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1' });
    prisma.lead.findUnique.mockResolvedValue({
      id: 'lead1', refCode: 'RD1', feePct: 2, dealPriceAtLock: 7500000, commissionLockedAt: new Date(), commissionVersion: 1,
      buyerFeedbackStatus: 'VERIFIED_CLOSED', status: 'SITE_VISIT_DONE', assignedPartnerId: 'p1', property: { price: 7500000 },
      assignedPartner: { id: 'p1', name: 'Asha', payoutAccountStatus: 'ACTIVE', razorpayFundAccountId: 'fa_1' }, ...letter,
    });
    prisma.leadCommissionLine.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', name: 'Asha', panNumber: 'ABCDE1234F', gstin: null });
    prisma.tdsEntry.findMany.mockResolvedValue([]);
    return escrow.getReleasePlan('esc1');
  };
  test('uploaded but not verified: not ready, and the letter is the blocker', async () => {
    const plan = await planWith({ allocationLetterUrl: 'https://x/letter.pdf', allocationLetterVerifiedAt: null });
    expect(plan.readyToRelease).toBe(false);
    expect(plan.unmetBlocking).toContain('ALLOCATION_LETTER');
  });
  test('uploaded and verified: the letter no longer blocks', async () => {
    const plan = await planWith({ allocationLetterUrl: 'https://x/letter.pdf', allocationLetterVerifiedAt: new Date() });
    expect(plan.unmetBlocking).not.toContain('ALLOCATION_LETTER');
  });
  test('not uploaded: blocks', async () => {
    const plan = await planWith({ allocationLetterUrl: null, allocationLetterVerifiedAt: null });
    expect(plan.unmetBlocking).toContain('ALLOCATION_LETTER');
  });
});

describe('checkout breakdown', () => {
  test('Rs 50,000 token: buyer pays 51,209, fee 1,209; refund terms from settings', async () => {
    const q = await escrow.getCheckoutQuote(50000);
    expect(q).toMatchObject({
      tokenPaise: 5000000, processingFeePaise: 120900, totalPaise: 5120900,
      refundWindowHours: 48, cancellationChargePaise: 299900, holdDays: 30, processingFeeEnabled: true,
    });
  });
  test('fee switched off by setting', async () => {
    prisma.platformConfig.findMany.mockResolvedValue([{ key: 'processing_fee_enabled', value: 'false' }]);
    const q = await escrow.getCheckoutQuote(50000);
    expect(q).toMatchObject({ processingFeePaise: 0, totalPaise: 5000000 });
  });
  test('rejects a missing amount', async () => {
    await expect(escrow.getCheckoutQuote(0)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('refund dry run (what a cancelling buyer is told)', () => {
  const held = (hoursAgo, extra = {}) => ({
    id: 'esc1', leadId: 'lead1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1',
    processingFeePaise: 120900, heldAt: new Date(Date.now() - hoursAgo * 3600e3), ...extra,
  });
  test('inside 48 h: 50,000 back', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held(10));
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: null });
    const q = await escrow.refund('esc1', 'u1', null, { reason: 'BUYER_CANCEL', dryRun: true });
    expect(q).toMatchObject({ stage: 'WITHIN_WINDOW', refundPaise: 5000000 });
  });
  test('after 48 h: 47,001 back, charge 2,999 shown', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held(72));
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: null });
    const q = await escrow.refund('esc1', 'u1', null, { reason: 'BUYER_CANCEL', dryRun: true });
    expect(q).toMatchObject({ stage: 'AFTER_WINDOW', refundPaise: 4700100, cancellationChargePaise: 299900 });
  });
  test('letter verified: not refundable, and a real refund attempt is refused with 409', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held(72));
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: 'https://x/letter.pdf', allocationLetterVerifiedAt: new Date() });
    expect((await escrow.refund('esc1', 'u1', null, { reason: 'BUYER_CANCEL', dryRun: true })).refundable).toBe(false);
    await expect(escrow.refund('esc1', 'u1', null, { reason: 'BUYER_CANCEL' }))
      .rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' } });
  });
  test('seller backs out: token + fee', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held(300));
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: 'x' });
    const q = await escrow.refund('esc1', 'admin1', null, { reason: 'SELLER_BACKOUT', dryRun: true });
    expect(q).toMatchObject({ refundPaise: 5120900, feeReturned: true, cancellationChargePaise: 0 });
  });
});
