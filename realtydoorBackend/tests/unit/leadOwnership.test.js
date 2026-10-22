const { decideBuyerOwnership } = require('../../src/lib/leadOwnership');

const asOf = new Date('2026-10-22');
const daysAgo = (n) => new Date(asOf.getTime() - n * 86_400_000);
const partnerLead = (partner, createdDaysAgo, extra = {}) => ({ addedByPartnerId: partner, createdAt: daysAgo(createdDaysAgo), ...extra });
const run = (o) => decideBuyerOwnership({ partnerId: 'A', windowDays: 60, asOf, ...o });

describe('decideBuyerOwnership', () => {
  it('a number nobody has is a new buyer for the adding partner', () => {
    expect(run({})).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
  });

  it('the same partner adding again inside the window stays credited', () => {
    expect(run({ priorLeads: [partnerLead('A', 20)] })).toMatchObject({ credited: true, reason: 'OWN_REGISTRATION' });
  });

  it('another partner who registered first and is still valid holds the buyer', () => {
    expect(run({ priorLeads: [partnerLead('B', 10)] })).toMatchObject({ credited: false, reason: 'OTHER_PARTNER', holderPartnerId: 'B' });
  });

  it('a registration with no activity past the window frees the buyer: a fresh registration is credited', () => {
    expect(run({ priorLeads: [partnerLead('B', 90)] })).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
  });

  it('a site visit or token inside the window keeps an old registration alive', () => {
    expect(run({ priorLeads: [partnerLead('B', 90, { otpVerifiedAt: daysAgo(10) })] })).toMatchObject({ reason: 'OTHER_PARTNER' });
    expect(run({ priorLeads: [partnerLead('B', 90, { escrowTransactions: [{ heldAt: daysAgo(5) }] })] })).toMatchObject({ reason: 'OTHER_PARTNER' });
  });

  it('a closed deal restarts the window (every deal inside the window)', () => {
    expect(run({ priorLeads: [partnerLead('A', 120, { closedAt: daysAgo(30) })] })).toMatchObject({ credited: true, reason: 'OWN_REGISTRATION' });
  });

  it('an earlier platform or admin lead makes the buyer ours', () => {
    expect(run({ priorLeads: [{ addedByPartnerId: null, createdAt: daysAgo(200) }] })).toMatchObject({ credited: false, reason: 'EXISTING_BUYER' });
  });

  it('a registered buyer account with no partner registration makes the buyer ours', () => {
    expect(run({ accountCreatedAt: daysAgo(400) })).toMatchObject({ credited: false, reason: 'EXISTING_BUYER' });
  });

  it('a buyer who enquires directly AFTER a valid partner registration stays the partner\'s', () => {
    const out = run({ priorLeads: [partnerLead('A', 20), { addedByPartnerId: null, createdAt: daysAgo(5) }], accountCreatedAt: daysAgo(3) });
    expect(out).toMatchObject({ credited: true, reason: 'OWN_REGISTRATION' });
  });

  it('a platform lead that came BEFORE the partner registration wins', () => {
    const out = run({ priorLeads: [{ addedByPartnerId: null, createdAt: daysAgo(100) }, partnerLead('A', 20)] });
    expect(out).toMatchObject({ credited: false, reason: 'EXISTING_BUYER' });
  });

  it('the first valid partner registration wins between two partners', () => {
    expect(run({ priorLeads: [partnerLead('B', 30), partnerLead('A', 10)] })).toMatchObject({ credited: false, reason: 'OTHER_PARTNER', holderPartnerId: 'B' });
  });
});
