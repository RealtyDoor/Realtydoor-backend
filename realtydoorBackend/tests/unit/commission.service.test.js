const {
  resolvePartnerLines, resolveRateCardLines, assertStoredLinesFitHeadroom,
  applyPartnerShareOverride, foldSelfListedPartnerLines, computeAmounts, computePlatformRetained,
} = require('../../src/modules/commission/commission.service');

describe('resolvePartnerLines', () => {
  test('resolves a single CLOSING_AGENT line unchanged — no PLATFORM line is ever appended', () => {
    const lines = resolvePartnerLines([{ payeeRole: 'CLOSING_AGENT', pct: 45 }], 150000);
    expect(lines).toEqual([{ payeeRole: 'CLOSING_AGENT', pct: 45, flatAmountPaise: null }]);
  });

  test('converts an ADVISOR flatAmountPaise into its equivalent pct of the fee', () => {
    // feeAmount = ₹150000. flatAmountPaise = ₹5000 = 500000 paise -> 3.3333...% -> rounds to 3.33
    const lines = resolvePartnerLines(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 500000 }],
      150000,
    );
    const advisor = lines.find((l) => l.payeeRole === 'ADVISOR');
    expect(advisor.pct).toBeCloseTo(3.33, 2);
    expect(advisor.flatAmountPaise).toBe(500000);
  });

  test('throws FLAT_AMOUNT_NEEDS_FEE when feeAmount is unknown', () => {
    expect(() => resolvePartnerLines(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 500000 }],
      null,
    )).toThrow(/known fee amount/);
  });

  test('throws FLAT_AMOUNT_EXCEEDS_FEE when the flat amount is bigger than the whole fee', () => {
    expect(() => resolvePartnerLines(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 20000000 }],
      150000,
    )).toThrow(/cannot exceed the fee itself/);
  });

  test('throws NO_COMMISSION_LINES when nothing was submitted', () => {
    expect(() => resolvePartnerLines([], 100000))
      .toThrow(/At least one commission line is required/);
  });

  test('throws BAD_PAYEE_ROLE for an unknown role, including PLATFORM itself', () => {
    expect(() => resolvePartnerLines([{ payeeRole: 'PLATFORM', pct: 10 }], 100000))
      .toThrow(/Unknown payeeRole/);
    expect(() => resolvePartnerLines([{ payeeRole: 'OWNER', pct: 10 }], 100000))
      .toThrow(/Unknown payeeRole/);
  });

  test('throws DUPLICATE_PAYEE_ROLE for two lines naming the same role', () => {
    expect(() => resolvePartnerLines(
      [{ payeeRole: 'CLOSING_AGENT', pct: 10 }, { payeeRole: 'CLOSING_AGENT', pct: 20 }],
      100000,
    )).toThrow(/Duplicate line for CLOSING_AGENT/);
  });

  test('does NOT refuse lines summing past 100% — that check now happens in setLeadTerms against the real headroom (ΣPi + R > B), not here', () => {
    expect(() => resolvePartnerLines([{ payeeRole: 'CLOSING_AGENT', pct: 101 }], 100000)).not.toThrow();
  });

  test('throws BAD_PCT for a non-positive pct', () => {
    expect(() => resolvePartnerLines([{ payeeRole: 'CLOSING_AGENT', pct: 0 }], 100000))
      .toThrow(/must have a positive pct/);
  });
});

describe('resolveRateCardLines', () => {
  test('returns the submitted LISTING_AGENT/CLOSING_AGENT lines unchanged — no PLATFORM line is appended', () => {
    const lines = resolveRateCardLines([
      { payeeRole: 'LISTING_AGENT', pct: 20 },
      { payeeRole: 'CLOSING_AGENT', pct: 30 },
    ]);
    expect(lines).toEqual([
      { payeeRole: 'LISTING_AGENT', pct: 20 },
      { payeeRole: 'CLOSING_AGENT', pct: 30 },
    ]);
  });

  test('refuses an ADVISOR line — templates are deal-agnostic', () => {
    expect(() => resolveRateCardLines([{ payeeRole: 'ADVISOR', pct: 10 }]))
      .toThrow(/set per deal, not in a template/);
  });

  test('still refuses lines summing past 100% — a template that obviously can\'t fit is caught before it\'s ever applied', () => {
    expect(() => resolveRateCardLines([{ payeeRole: 'LISTING_AGENT', pct: 60 }, { payeeRole: 'CLOSING_AGENT', pct: 50 }]))
      .toThrow(/leaves nothing for the platform's cost recovery/);
  });
});

describe('computePlatformRetained', () => {
  test('R = (collection + payout) + GST on both, when input credit is not claimed', () => {
    const out = computePlatformRetained(180000, { collectionPct: 2, payoutPct: 0.5, gstPct: 18, inputCreditClaimed: false });
    // rawCost = 180000 * 2.5% = 4500. gst = 4500 * 18% = 810. R = 5310.
    expect(out.retainedAmount).toBe(5310);
    expect(out.platformPctOfFee).toBe(2.95);
  });

  test('R excludes GST when input credit is claimed', () => {
    const out = computePlatformRetained(180000, { collectionPct: 2, payoutPct: 0.5, gstPct: 18, inputCreditClaimed: true });
    expect(out.retainedAmount).toBe(4500);
  });

  test('returns 0 when feeAmount is not yet known — not a false "no cost" claim elsewhere', () => {
    const out = computePlatformRetained(null, { collectionPct: 2, payoutPct: 0.5, gstPct: 18, inputCreditClaimed: false });
    expect(out.retainedAmount).toBe(0);
    expect(out.platformPctOfFee).toBe(0);
  });

  test('returns 0 when every rate is 0 — the safe no-op default before real schedules are configured', () => {
    const out = computePlatformRetained(180000, { collectionPct: 0, payoutPct: 0, gstPct: 0, inputCreditClaimed: false });
    expect(out.retainedAmount).toBe(0);
  });
});

describe('assertStoredLinesFitHeadroom', () => {
  test('passes when partner lines plus R fit inside the fee', () => {
    expect(() => assertStoredLinesFitHeadroom([{ pct: 50, flatAmountPaise: null }], 180000, 5310)).not.toThrow();
  });

  test('throws when partner lines plus R exceed the fee', () => {
    expect(() => assertStoredLinesFitHeadroom([{ pct: 99, flatAmountPaise: null }], 180000, 5310))
      .toThrow(/this is a bug, not an input error/);
  });

  test('is a no-op when feeAmount is not yet known', () => {
    expect(() => assertStoredLinesFitHeadroom([{ pct: 99, flatAmountPaise: null }], null, 5310)).not.toThrow();
  });
});

describe('applyPartnerShareOverride', () => {
  test('rescales a CLOSING_AGENT line to the new partner share — no PLATFORM line involved', () => {
    const out = applyPartnerShareOverride([{ payeeRole: 'CLOSING_AGENT', pct: 50 }], 70);
    expect(out).toEqual([{ payeeRole: 'CLOSING_AGENT', pct: 70 }]);
  });

  test('preserves the relative split across LISTING_AGENT + CLOSING_AGENT', () => {
    const lines = [{ payeeRole: 'LISTING_AGENT', pct: 20 }, { payeeRole: 'CLOSING_AGENT', pct: 20 }];
    const out = applyPartnerShareOverride(lines, 60);
    const la = out.find((l) => l.payeeRole === 'LISTING_AGENT');
    const ca = out.find((l) => l.payeeRole === 'CLOSING_AGENT');
    expect(la.pct).toBe(30);
    expect(ca.pct).toBe(30);
  });

  test('leaves a separate ADVISOR line untouched — an override is about the assigned partner only', () => {
    const lines = [
      { payeeRole: 'CLOSING_AGENT', pct: 40 },
      { payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 10, flatAmountPaise: 500000 },
    ];
    const out = applyPartnerShareOverride(lines, 80);
    const advisor = out.find((l) => l.payeeRole === 'ADVISOR');
    expect(advisor).toEqual({ payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 10, flatAmountPaise: 500000 });
  });

  test('rejects an out-of-range partnerSharePct', () => {
    expect(() => applyPartnerShareOverride([{ payeeRole: 'CLOSING_AGENT', pct: 50 }], 150))
      .toThrow(/between 0 and 100/);
  });
});

describe('foldSelfListedPartnerLines (R21)', () => {
  test('removes a CLOSING_AGENT line outright — nothing absorbs it any more, it is just unallocated headroom', () => {
    expect(foldSelfListedPartnerLines([{ payeeRole: 'CLOSING_AGENT', pct: 50 }])).toEqual([]);
  });

  test('is a no-op when there is no partner-role line to fold', () => {
    expect(foldSelfListedPartnerLines([])).toEqual([]);
  });

  test('leaves a separate ADVISOR line untouched', () => {
    const lines = [
      { payeeRole: 'CLOSING_AGENT', pct: 40 },
      { payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 10, flatAmountPaise: 500000 },
    ];
    const out = foldSelfListedPartnerLines(lines);
    expect(out).toEqual([{ payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 10, flatAmountPaise: 500000 }]);
  });
});

describe('computeAmounts', () => {
  test('returns null when the deal price or feePct is not yet known', () => {
    expect(computeAmounts({ dealPriceAtLock: null, feePct: 2 }, [])).toBeNull();
    expect(computeAmounts({ dealPriceAtLock: 9000000, feePct: null }, [])).toBeNull();
  });

  test('computes feeAmount, sellerNet, platformRetained/headroom, and a per-payee breakdown — no PLATFORM entry among the lines', () => {
    const lead = { dealPriceAtLock: 9000000, feePct: 2, platformCommissionPct: 2.95, commissionAmountPaise: 531000 };
    const lines = [{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50, flatAmountPaise: null }];
    const amounts = computeAmounts(lead, lines);
    expect(amounts.feeAmount).toBe(180000);
    expect(amounts.sellerNet).toBe(8820000);
    expect(amounts.platformRetained).toBe(5310);
    expect(amounts.platformShareOfFee).toBe(2.95);
    expect(amounts.partnerTotal).toBe(90000);
    expect(amounts.headroom).toBe(84690);
    expect(amounts.byPayee).toEqual([
      { payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50, amount: 90000, flatAmountPaise: null },
    ]);
  });

  test('shows an ADVISOR flat amount exactly, not recomputed from pct', () => {
    const lead = { dealPriceAtLock: 9000000, feePct: 2, platformCommissionPct: 0, commissionAmountPaise: 0 };
    const lines = [{ payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 2.78, flatAmountPaise: 500000 }];
    const amounts = computeAmounts(lead, lines);
    expect(amounts.byPayee[0].amount).toBe(5000);
  });

  test('platformRetained/headroom default to 0/full-fee when the lead has no stored snapshot yet', () => {
    const lead = { dealPriceAtLock: 9000000, feePct: 2, platformCommissionPct: null, commissionAmountPaise: null };
    const amounts = computeAmounts(lead, []);
    expect(amounts.platformRetained).toBe(0);
    expect(amounts.headroom).toBe(180000);
  });
});
