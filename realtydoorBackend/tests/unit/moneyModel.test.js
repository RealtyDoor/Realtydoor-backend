const m = require('../../src/lib/moneyModel');
const { parseSettings, DEFINITIONS } = require('../../src/modules/money/moneyConfig');
const { buildPartnerQuote } = require('../../src/lib/commissionQuote');

const S = parseSettings([]); // all defaults = the owner's 22 Oct 2026 decisions
const rs = (r) => m.toPaise(r);

describe('defaults', () => {
  test('match the Revision 3 decisions', () => {
    expect(S.commission).toEqual({ partnerRatePct: 1, platformFeePct: 1, gstPct: 18 });
    expect(S.refund.freeWindowHours).toBe(48);
    expect(S.refund.cancellationChargePaise).toBe(299900);
    expect(S.tds).toMatchObject({ ratePct: 2, noPanRatePct: 20, thresholdPaise: 2000000, missingPanAction: 'DEDUCT_HIGHER' });
    expect(S.tokenPlatformFeePct).toBe(0);
  });
  test('a stored row overrides the default; junk falls back', () => {
    const t = parseSettings([
      { key: 'cancellation_charge_rupees', value: '1999' },
      { key: 'tds_rate_pct', value: 'abc' },
      { key: 'processing_fee_enabled', value: 'false' },
      { key: 'tds_missing_pan_action', value: 'BLOCK' },
    ]);
    expect(t.refund.cancellationChargePaise).toBe(199900);
    expect(t.tds.ratePct).toBe(2);
    expect(t.processingFee.enabled).toBe(false);
    expect(t.tds.missingPanAction).toBe('BLOCK');
  });
  test('every setting has a default and a description', () => {
    for (const [k, [def, desc]] of Object.entries(DEFINITIONS)) {
      expect(def).not.toBeUndefined();
      expect(typeof desc).toBe('string');
      expect(k).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('processingFee (token / 0.9764, rounded up to the rupee)', () => {
  const fee = (rupees) => m.processingFee(rs(rupees), S.processingFee);
  test.each([
    [50000, 51209, 1209],
    [100000, 102418, 2418],
    [200000, 204835, 4835],
    [500000, 512086, 12086],
    [750000, 768128, 18128],
  ])('token %i -> buyer pays %i, fee %i (PRICING doc section 9)', (token, total, feeRupees) => {
    const r = fee(token);
    expect(r.totalPaise).toBe(total * 100);
    expect(r.feePaise).toBe(feeRupees * 100);
  });
  test('Razorpay 2.36% of what the buyer pays never exceeds the fee, so we net at least the token', () => {
    for (const token of [50000, 61234.5, 99999, 750000]) {
      const r = fee(token);
      expect(r.totalPaise - Math.round(r.totalPaise * 0.0236)).toBeGreaterThanOrEqual(rs(token) - 1);
    }
  });
  test('GST inside the fee is 18/118 of it', () => {
    expect(fee(50000).feeGstPaise).toBe(Math.round(120900 - 120900 / 1.18) );
  });
  test('switched off: no fee', () => {
    const r = m.processingFee(rs(50000), { ...S.processingFee, enabled: false });
    expect(r).toMatchObject({ feePaise: 0, totalPaise: rs(50000) });
  });
  test('follows a negotiated gateway rate', () => {
    const r = m.processingFee(rs(100000), { ...S.processingFee, gatewayPct: 1.5 });
    expect(r.totalPaise).toBe(Math.ceil(10000000 / (1 - 0.015 * 1.18) / 100) * 100);
  });
  test('rejects a bad token', () => {
    expect(() => m.processingFee(0, S.processingFee)).toThrow();
    expect(() => m.processingFee(10.5, S.processingFee)).toThrow();
  });
});

describe('commission = rate x final deal price (not the token)', () => {
  test('1% flat, below and above 1 crore, no cliff', () => {
    expect(m.partnerCommissionPaise(rs(7500000), 1)).toBe(rs(75000));
    expect(m.partnerCommissionPaise(rs(17500000), 1)).toBe(rs(175000));
    expect(m.partnerCommissionPaise(rs(9900000), 1)).toBe(rs(99000));
    expect(m.partnerCommissionPaise(rs(10100000), 1)).toBe(rs(101000));
  });
  test('negotiated project rates 2 / 2.5 / 3 %', () => {
    expect(m.partnerCommissionPaise(rs(7500000), 2)).toBe(rs(150000));
    expect(m.partnerCommissionPaise(rs(7500000), 2.5)).toBe(rs(187500));
    expect(m.partnerCommissionPaise(rs(7500000), 3)).toBe(rs(225000));
  });
  test('seller invoice: partner rate + platform fee + 18% GST on the whole', () => {
    expect(m.sellerInvoice(rs(7500000), { partnerRatePct: 1, platformFeePct: 1, gstPct: 18 })).toEqual({
      partnerPaise: rs(75000), platformPaise: rs(75000), subtotalPaise: rs(150000),
      gstPaise: rs(27000), totalPaise: rs(177000),
    });
    // a 2.5% project: 2.5 + 1 = 3.5% -> 2,62,500 + GST 47,250
    const p = m.sellerInvoice(rs(7500000), { partnerRatePct: 2.5, platformFeePct: 1, gstPct: 18 });
    expect(p.subtotalPaise).toBe(rs(262500));
    expect(p.gstPaise).toBe(rs(47250));
  });
});

describe('resolveCommissionRate precedence', () => {
  const def = { partnerRatePct: 1, platformFeePct: 1 };
  const all = {
    DEAL: { partnerRatePct: 4 }, PARTNER_OVERRIDE: { partnerRatePct: 3.5 }, PROJECT: { partnerRatePct: 3 },
    PROPERTY: { partnerRatePct: 2.5 }, CITY: { partnerRatePct: 2 },
  };
  test('deal > override > project > property > city > default', () => {
    const order = ['DEAL', 'PARTNER_OVERRIDE', 'PROJECT', 'PROPERTY', 'CITY'];
    const left = { ...all };
    for (const source of order) {
      expect(m.resolveCommissionRate(left, def).source).toBe(source);
      delete left[source];
    }
    expect(m.resolveCommissionRate(left, def).source).toBe('PLATFORM_DEFAULT');
  });
  test('Custom flag only when it differs from the default; fee total adds up', () => {
    const r = m.resolveCommissionRate({ PROJECT: { partnerRatePct: 2.5, reason: 'Big builder' } }, def);
    expect(r).toMatchObject({ isCustom: true, totalFeePct: 3.5, platformFeePct: 1, reason: 'Big builder' });
    expect(m.resolveCommissionRate({ PROJECT: { partnerRatePct: 1, platformFeePct: 1 } }, def).isCustom).toBe(false);
    expect(m.resolveCommissionRate({}, def).isCustom).toBe(false);
  });
});

describe('financial year and TDS deposit date', () => {
  test('quarters', () => {
    expect(m.financialYearOf('2026-10-22T10:00:00Z')).toMatchObject({ financialYear: '2026-27', quarter: 3 });
    expect(m.financialYearOf('2027-03-31T10:00:00Z')).toMatchObject({ financialYear: '2026-27', quarter: 4 });
    expect(m.financialYearOf('2026-04-01T00:00:00+05:30')).toMatchObject({ financialYear: '2026-27', quarter: 1 });
    expect(m.financialYearOf('2026-03-31T20:00:00Z')).toMatchObject({ financialYear: '2026-27', quarter: 1 }); // 1 Apr IST
    expect(m.financialYearOf('2026-07-01T10:00:00Z').quarter).toBe(2);
  });
  test('deposit due the 7th of next month; March deductions 30 April', () => {
    const ist = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    expect(ist(m.tdsDepositDueDate('2026-10-22T10:00:00Z'))).toBe('2026-11-07');
    expect(ist(m.tdsDepositDueDate('2026-12-30T10:00:00Z'))).toBe('2027-01-07');
    expect(ist(m.tdsDepositDueDate('2027-03-15T10:00:00Z'))).toBe('2027-04-30');
  });
});

describe('computeTds (2%, 20% without PAN, Rs 20,000 a year, GST excluded)', () => {
  const tds = (o) => m.computeTds({ settings: S.tds, pan: 'ABCDE1234F', ...o });
  test('Rs 75 L deal: commission 75,000 -> TDS 1,500, net 73,500', () => {
    const r = tds({ commissionPaise: rs(75000) });
    expect(r).toMatchObject({ tdsPaise: rs(1500), netPaise: rs(73500), ratePct: 2, rateReason: 'STANDARD', thresholdReached: true });
  });
  test('below the yearly threshold: nothing withheld', () => {
    const r = tds({ commissionPaise: rs(15000) });
    expect(r).toMatchObject({ tdsPaise: 0, netPaise: rs(15000), rateReason: 'BELOW_THRESHOLD', thresholdReached: false });
    expect(tds({ commissionPaise: rs(20000) }).tdsPaise).toBe(0); // exactly the limit: not exceeded
    expect(tds({ commissionPaise: rs(20001) }).tdsPaise).toBe(rs(400.02));
  });
  test('the payout that crosses the threshold is taxed on everything credited so far (catch-up)', () => {
    const first = tds({ commissionPaise: rs(15000) });
    const second = tds({ commissionPaise: rs(10000), ytdBasePaise: rs(15000), taxedBasePaise: first.baseTaxedPaise });
    expect(second.baseTaxedPaise).toBe(rs(25000));
    expect(second.tdsPaise).toBe(rs(500));
    const third = tds({ commissionPaise: rs(10000), ytdBasePaise: rs(25000), taxedBasePaise: second.baseTaxedPaise });
    expect(third.baseTaxedPaise).toBe(rs(10000));
    expect(third.tdsPaise).toBe(rs(200));
    // yearly TDS = 2% of the total commission 35,000
    expect(first.tdsPaise + second.tdsPaise + third.tdsPaise).toBe(rs(700));
  });
  test('catch-up never takes more than the payout itself', () => {
    const r = tds({ commissionPaise: rs(100), ytdBasePaise: rs(19950), taxedBasePaise: 0, settings: { ...S.tds, ratePct: 100 } });
    expect(r.tdsPaise).toBe(rs(100));
  });
  test('no PAN: 20%', () => {
    const r = tds({ commissionPaise: rs(75000), pan: '' });
    expect(r).toMatchObject({ tdsPaise: rs(15000), ratePct: 20, rateReason: 'NO_PAN', hasPan: false });
    expect(tds({ commissionPaise: rs(75000), pan: 'not-a-pan' }).ratePct).toBe(20);
  });
  test('no PAN with the BLOCK setting: refused', () => {
    const r = tds({ commissionPaise: rs(75000), pan: null, settings: { ...S.tds, missingPanAction: 'BLOCK' } });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('NO_PAN');
  });
  test('a lowercase PAN with spaces still counts', () => {
    expect(m.isValidPan(' abcde1234f ')).toBe(true);
    expect(m.isValidPan('ABCDE12345')).toBe(false);
  });
});

describe('partnerPayout statement (section 2.6a)', () => {
  const tds = m.computeTds({ commissionPaise: rs(75000), pan: 'ABCDE1234F', settings: S.tds });
  test('unregistered partner: 73,500 now, a commission voucher, no GST', () => {
    const p = m.partnerPayout({ commissionPaise: rs(75000), tds, gstRegistered: false, gstPct: 18 });
    expect(p).toMatchObject({ payNowPaise: rs(73500), gstPaise: 0, gstPendingPaise: 0, documentType: 'COMMISSION_VOUCHER' });
  });
  test('registered partner: 73,500 now, 13,500 GST held until the invoice is matched, total 87,000', () => {
    const p = m.partnerPayout({ commissionPaise: rs(75000), tds, gstRegistered: true, gstPct: 18 });
    expect(p).toMatchObject({
      payNowPaise: rs(73500), gstPaise: rs(13500), gstPendingPaise: rs(13500),
      totalWithGstPaise: rs(87000), documentType: 'TAX_INVOICE',
    });
  });
});

describe('refundQuote (section 2.2)', () => {
  const base = { tokenPaise: rs(50000), feePaise: rs(1209), paidAt: '2026-10-22T10:00:00Z', settings: S.refund };
  const at = (hours) => new Date(new Date(base.paidAt).getTime() + hours * 3600e3);

  test('within 48 h: full token, fee not returned, no charge', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(47.9) });
    expect(q).toMatchObject({ stage: 'WITHIN_WINDOW', refundPaise: rs(50000), feeReturned: false, cancellationChargePaise: 0, refundable: true });
  });
  test('after 48 h, letter not verified: token minus Rs 2,999 (50,000 -> 47,001)', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(48) });
    expect(q).toMatchObject({ stage: 'AFTER_WINDOW', refundPaise: rs(47001), cancellationChargePaise: rs(2999), feeReturned: false });
  });
  test('the charge is a setting', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(100), settings: { ...S.refund, cancellationChargePaise: rs(1000) } });
    expect(q.refundPaise).toBe(rs(49000));
  });
  test('the charge never exceeds the token', () => {
    const q = m.refundQuote({ ...base, tokenPaise: rs(2000), reason: 'BUYER_CANCEL', now: at(100) });
    expect(q.cancellationChargePaise).toBe(rs(2000));
    expect(q.refundPaise).toBe(0);
  });
  test('split of the charge between seller and Realtydoor is a setting, GST on our part', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(100), settings: { ...S.refund, realtydoorSharePct: 40 } });
    expect(q.cancellationSplit).toMatchObject({ chargePaise: rs(2999), realtydoorPaise: rs(1199.6), sellerPaise: rs(2999) - rs(1199.6) });
    expect(q.cancellationSplit.gstOnRealtydoorPaise).toBe(rs(1199.6) - Math.round(rs(1199.6) / 1.18));
  });
  test('after the allocation letter is verified: not refundable by the platform', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(100), letterVerified: true });
    expect(q).toMatchObject({ refundable: false, refundPaise: 0, stage: 'AFTER_VERIFICATION' });
  });
  test('BUG-040: a verified letter beats the free window (no refund even a minute after paying)', () => {
    const q = m.refundQuote({ ...base, reason: 'BUYER_CANCEL', now: at(1), letterVerified: true });
    expect(q).toMatchObject({ refundable: false, refundPaise: 0, stage: 'AFTER_VERIFICATION' });
  });
  test.each(['SELLER_BACKOUT', 'LISTING_WRONG', 'OUR_FAULT'])('%s: token + fee, no charge, even after 48 h and after verification', (reason) => {
    const q = m.refundQuote({ ...base, reason, now: at(500), letterVerified: true });
    expect(q).toMatchObject({ refundPaise: rs(51209), feeReturned: true, cancellationChargePaise: 0, refundable: true });
  });
  test('admin default refunds the token only, as before', () => {
    const q = m.refundQuote({ ...base, reason: 'ADMIN_TOKEN_ONLY', now: at(500) });
    expect(q).toMatchObject({ refundPaise: rs(50000), feeReturned: false });
  });
  test('an escrow paid before the fee existed returns just the token on a fault refund', () => {
    const q = m.refundQuote({ ...base, feePaise: 0, reason: 'OUR_FAULT', now: at(500) });
    expect(q.refundPaise).toBe(rs(50000));
  });
  test('unknown reason throws', () => {
    expect(() => m.refundQuote({ ...base, reason: 'WHATEVER' })).toThrow();
  });
});

describe('buildPartnerQuote (shown to the partner before they work a lead)', () => {
  test('null until terms are set', () => {
    expect(buildPartnerQuote({})).toBeNull();
  });
  test('standard 1%', () => {
    expect(buildPartnerQuote({
      partnerRatePct: 1, dealPriceAtLock: 7500000, commissionRateSource: 'PLATFORM_DEFAULT', commissionRateCustom: false,
      commissionLockedAt: new Date(),
    })).toMatchObject({ partnerRatePct: 1, estimatedCommission: 75000, isCustom: false, label: null, reason: null, locked: true });
  });
  test('Custom project rate carries its label and reason', () => {
    expect(buildPartnerQuote({
      partnerRatePct: 2.5, property: { price: 7500000 }, commissionRateSource: 'PROJECT',
      commissionRateCustom: true, commissionRateReason: 'Launch push',
    })).toMatchObject({ estimatedCommission: 187500, label: 'Custom', reason: 'Launch push', source: 'PROJECT', locked: false });
  });
});
