const {
  resolveLinesWithPlatformResidual, resolveRateCardLines, assertStoredLinesSumTo100,
  applyPartnerShareOverride, foldSelfListedPartnerLines, computeAmounts, derivedFields,
} = require('../../src/modules/commission/commission.service');

describe('resolveLinesWithPlatformResidual', () => {
  test('appends PLATFORM as the residual of a single CLOSING_AGENT line', () => {
    const lines = resolveLinesWithPlatformResidual([{ payeeRole: 'CLOSING_AGENT', pct: 45 }], 150000);
    expect(lines).toEqual([
      { payeeRole: 'CLOSING_AGENT', pct: 45, flatAmountPaise: null },
      { payeeRole: 'PLATFORM', pct: 55, flatAmountPaise: null, payeeUserId: null },
    ]);
  });

  test('silently drops a submitted PLATFORM line and recomputes it', () => {
    const lines = resolveLinesWithPlatformResidual(
      [{ payeeRole: 'CLOSING_AGENT', pct: 40 }, { payeeRole: 'PLATFORM', pct: 1 }],
      100000,
    );
    expect(lines.find((l) => l.payeeRole === 'PLATFORM').pct).toBe(60);
  });

  test('converts an ADVISOR flatAmountPaise into its equivalent pct of the fee', () => {
    // feeAmount = ₹150000. flatAmountPaise = ₹5000 = 500000 paise -> 3.3333...% -> rounds to 3.33
    const lines = resolveLinesWithPlatformResidual(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 500000 }],
      150000,
    );
    const advisor = lines.find((l) => l.payeeRole === 'ADVISOR');
    expect(advisor.pct).toBeCloseTo(3.33, 2);
    expect(advisor.flatAmountPaise).toBe(500000);
  });

  test('throws FLAT_AMOUNT_NEEDS_FEE when feeAmount is unknown', () => {
    expect(() => resolveLinesWithPlatformResidual(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 500000 }],
      null,
    )).toThrow(/known fee amount/);
  });

  test('throws FLAT_AMOUNT_EXCEEDS_FEE when the flat amount is bigger than the whole fee', () => {
    expect(() => resolveLinesWithPlatformResidual(
      [{ payeeRole: 'ADVISOR', payeeUserId: 'u1', flatAmountPaise: 20000000 }],
      150000,
    )).toThrow(/cannot exceed the fee itself/);
  });

  test('throws NO_COMMISSION_LINES when nothing but PLATFORM was submitted', () => {
    expect(() => resolveLinesWithPlatformResidual([{ payeeRole: 'PLATFORM', pct: 100 }], 100000))
      .toThrow(/At least one commission line is required/);
  });

  test('throws BAD_PAYEE_ROLE for an unknown role', () => {
    expect(() => resolveLinesWithPlatformResidual([{ payeeRole: 'OWNER', pct: 10 }], 100000))
      .toThrow(/Unknown payeeRole/);
  });

  test('throws DUPLICATE_PAYEE_ROLE for two lines naming the same role', () => {
    expect(() => resolveLinesWithPlatformResidual(
      [{ payeeRole: 'CLOSING_AGENT', pct: 10 }, { payeeRole: 'CLOSING_AGENT', pct: 20 }],
      100000,
    )).toThrow(/Duplicate line for CLOSING_AGENT/);
  });

  test('throws LINES_EXCEED_FEE when lines sum past 100%', () => {
    expect(() => resolveLinesWithPlatformResidual([{ payeeRole: 'CLOSING_AGENT', pct: 101 }], 100000))
      .toThrow(/leaves nothing for the platform/);
  });

  test('throws BAD_PCT for a non-positive pct', () => {
    expect(() => resolveLinesWithPlatformResidual([{ payeeRole: 'CLOSING_AGENT', pct: 0 }], 100000))
      .toThrow(/must have a positive pct/);
  });
});

describe('resolveRateCardLines', () => {
  test('appends PLATFORM residual for a LISTING_AGENT/CLOSING_AGENT split', () => {
    const lines = resolveRateCardLines([
      { payeeRole: 'LISTING_AGENT', pct: 20 },
      { payeeRole: 'CLOSING_AGENT', pct: 30 },
    ]);
    expect(lines).toEqual([
      { payeeRole: 'LISTING_AGENT', pct: 20 },
      { payeeRole: 'CLOSING_AGENT', pct: 30 },
      { payeeRole: 'PLATFORM', pct: 50 },
    ]);
  });

  test('refuses an ADVISOR line — templates are deal-agnostic', () => {
    expect(() => resolveRateCardLines([{ payeeRole: 'ADVISOR', pct: 10 }]))
      .toThrow(/set per deal, not in a template/);
  });
});

describe('assertStoredLinesSumTo100', () => {
  test('passes for lines that sum to exactly 100', () => {
    expect(() => assertStoredLinesSumTo100([{ pct: 40 }, { pct: 60 }])).not.toThrow();
  });

  test('tolerates float drift within PCT_EPSILON (thirds)', () => {
    expect(() => assertStoredLinesSumTo100([{ pct: 33.33 }, { pct: 33.33 }, { pct: 33.34 }])).not.toThrow();
  });

  test('throws when lines genuinely do not sum to 100', () => {
    expect(() => assertStoredLinesSumTo100([{ pct: 40 }, { pct: 50 }]))
      .toThrow(/this is a bug, not an input error/);
  });
});

describe('applyPartnerShareOverride', () => {
  test('rescales a CLOSING_AGENT line to the new partner share, recomputing PLATFORM', () => {
    const lines = [{ payeeRole: 'CLOSING_AGENT', pct: 50 }, { payeeRole: 'PLATFORM', pct: 50 }];
    const out = applyPartnerShareOverride(lines, 70);
    expect(out).toEqual([
      { payeeRole: 'PLATFORM', pct: 30 },
      { payeeRole: 'CLOSING_AGENT', pct: 70 },
    ]);
  });

  test('preserves the relative split across LISTING_AGENT + CLOSING_AGENT', () => {
    const lines = [
      { payeeRole: 'LISTING_AGENT', pct: 20 }, { payeeRole: 'CLOSING_AGENT', pct: 20 }, { payeeRole: 'PLATFORM', pct: 60 },
    ];
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
      { payeeRole: 'PLATFORM', pct: 50 },
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
  test('folds a CLOSING_AGENT line into PLATFORM', () => {
    const lines = [{ payeeRole: 'CLOSING_AGENT', pct: 50 }, { payeeRole: 'PLATFORM', pct: 50 }];
    expect(foldSelfListedPartnerLines(lines)).toEqual([{ payeeRole: 'PLATFORM', pct: 100 }]);
  });

  test('is a no-op when there is no partner-role line to fold', () => {
    const lines = [{ payeeRole: 'PLATFORM', pct: 100 }];
    expect(foldSelfListedPartnerLines(lines)).toBe(lines);
  });

  test('leaves a separate ADVISOR line untouched', () => {
    const lines = [
      { payeeRole: 'CLOSING_AGENT', pct: 40 },
      { payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 10, flatAmountPaise: 500000 },
      { payeeRole: 'PLATFORM', pct: 50 },
    ];
    const out = foldSelfListedPartnerLines(lines);
    expect(out.find((l) => l.payeeRole === 'ADVISOR').pct).toBe(10);
    expect(out.find((l) => l.payeeRole === 'PLATFORM').pct).toBe(90);
    expect(out.find((l) => l.payeeRole === 'CLOSING_AGENT')).toBeUndefined();
  });

  test('synthesizes a PLATFORM line when none existed yet', () => {
    const lines = [{ payeeRole: 'CLOSING_AGENT', pct: 30 }];
    expect(foldSelfListedPartnerLines(lines)).toEqual([{ payeeRole: 'PLATFORM', pct: 30 }]);
  });
});

describe('computeAmounts', () => {
  test('returns null when the deal price or feePct is not yet known', () => {
    expect(computeAmounts({ dealPriceAtLock: null, feePct: 2 }, [])).toBeNull();
    expect(computeAmounts({ dealPriceAtLock: 9000000, feePct: null }, [])).toBeNull();
  });

  test('computes feeAmount, sellerNet, and a per-payee breakdown', () => {
    const lead = { dealPriceAtLock: 9000000, feePct: 2 };
    const lines = [
      { payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50, flatAmountPaise: null },
      { payeeRole: 'PLATFORM', payeeUserId: null, pct: 50, flatAmountPaise: null },
    ];
    const amounts = computeAmounts(lead, lines);
    expect(amounts.feeAmount).toBe(180000);
    expect(amounts.sellerNet).toBe(8820000);
    expect(amounts.byPayee).toEqual([
      { payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50, amount: 90000, flatAmountPaise: null },
      { payeeRole: 'PLATFORM', payeeUserId: null, pct: 50, amount: 90000, flatAmountPaise: null },
    ]);
  });

  test('shows an ADVISOR flat amount exactly, not recomputed from pct', () => {
    const lead = { dealPriceAtLock: 9000000, feePct: 2 };
    const lines = [{ payeeRole: 'ADVISOR', payeeUserId: 'adv1', pct: 2.78, flatAmountPaise: 500000 }];
    const amounts = computeAmounts(lead, lines);
    expect(amounts.byPayee[0].amount).toBe(5000);
  });
});

describe('derivedFields', () => {
  test('computes platformCommissionPct as feePct scaled by the platform share of the fee', () => {
    const out = derivedFields(2, [{ payeeRole: 'PLATFORM', pct: 60 }], 9000000);
    expect(out.platformCommissionPct).toBe(1.2);
    expect(out.commissionAmountPaise).toBe(Math.round(9000000 * 0.012 * 100));
  });

  test('defaults platformCommissionPct to 0 when there is no PLATFORM line', () => {
    const out = derivedFields(2, [{ payeeRole: 'CLOSING_AGENT', pct: 100 }], 9000000);
    expect(out.platformCommissionPct).toBe(0);
  });

  test('omits commissionAmountPaise when dealPrice is not yet known', () => {
    const out = derivedFields(2, [{ payeeRole: 'PLATFORM', pct: 100 }], null);
    expect(out).toEqual({ platformCommissionPct: 2 });
  });
});
