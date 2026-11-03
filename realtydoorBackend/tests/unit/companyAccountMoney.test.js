// An agency that signs up as ONE company partner (company PAN, legal name as companyName, one bank account), versus the
// same people on separate logins. Pins what the money rules do for a company PAN, and why one account is the right launch shape.
const money = require('../../src/lib/moneyModel');

const TDS = { ratePct: 2, noPanRatePct: 20, thresholdPaise: 2_000_000, missingPanAction: 'DEDUCT_HIGHER' };
const rupees = (n) => n * 100;

describe('company PAN is accepted like any other PAN', () => {
  test.each([
    ['company', 'AABCR1234C'],
    ['person', 'ABCPD1234E'],
    ['firm', 'AAAFR1234K'],
    ['lower case with spaces', ' aabcr1234c '],
  ])('%s: %s', (_label, pan) => {
    expect(money.isValidPan(pan)).toBe(true);
  });
  test('a malformed PAN is refused', () => {
    for (const pan of ['AABCR1234', 'AABCR12345', '1ABCR1234C', '', null, undefined]) expect(money.isValidPan(pan)).toBe(false);
  });
});

describe('TDS on one company account', () => {
  const deal = (ytd, taxed = 0) => money.computeTds({ commissionPaise: rupees(10_000), ytdBasePaise: ytd, taxedBasePaise: taxed, pan: 'AABCR1234C', settings: TDS });

  test('three Rs 10,000 deals: the third crosses the Rs 20,000 threshold and TDS is taken on the whole Rs 30,000', () => {
    const first = deal(0);
    const second = deal(rupees(10_000));
    const third = deal(rupees(20_000));
    expect(first.tdsPaise).toBe(0);
    expect(second.tdsPaise).toBe(0);
    expect(third.thresholdReached).toBe(true);
    expect(third.tdsPaise).toBe(rupees(600)); // 2% of 30,000
    expect(third.netPaise).toBe(rupees(10_000) - rupees(600));
    expect(third.hasPan).toBe(true);
  });
});

describe('the same commission on three separate logins', () => {
  test('each login stays under the threshold, so no TDS is taken at all (why one account is used)', () => {
    const totals = [0, 1, 2].map(() => money.computeTds({
      commissionPaise: rupees(10_000), ytdBasePaise: 0, taxedBasePaise: 0, pan: 'ABCPD1234E', settings: TDS,
    }).tdsPaise);
    expect(totals).toEqual([0, 0, 0]);
  });
});

describe('PAN name match for a company account (automated check, when a vendor key is set)', () => {
  const run = async (registryName, companyName) => {
    jest.resetModules();
    process.env.KYC_VERIFICATION_API_KEY = 'test-key';
    jest.doMock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { result: { user_full_name: registryName } } }) }));
    const kyc = require('../../src/lib/kycVerification');
    const out = await kyc.verifyPan('AABCR1234C', companyName);
    delete process.env.KYC_VERIFICATION_API_KEY;
    jest.dontMock('axios');
    return out;
  };

  test('the legal name matches whatever the case, spacing and word order', async () => {
    expect((await run('SUNRISE PROPERTY CONSULTANTS PRIVATE LIMITED', 'Sunrise Property Consultants Private Limited')).status).toBe('VERIFIED');
    expect((await run('SUNRISE PROPERTY CONSULTANTS PRIVATE LIMITED', 'sunrise  property consultants, private limited.')).status).toBe('VERIFIED');
  });
  test('"Pvt Ltd" against "Private Limited" is flagged for admin to review, never auto-rejected', async () => {
    const out = await run('SUNRISE PROPERTY CONSULTANTS PRIVATE LIMITED', 'Sunrise Property Consultants Pvt Ltd');
    expect(out.status).toBe('NAME_MISMATCH');
    expect(out.verifiedName).toBe('SUNRISE PROPERTY CONSULTANTS PRIVATE LIMITED');
  });
  test('a trade name that is not the legal name is flagged too', async () => {
    expect((await run('SUNRISE PROPERTY CONSULTANTS PRIVATE LIMITED', 'Sunrise Homes')).status).toBe('NAME_MISMATCH');
  });
});
