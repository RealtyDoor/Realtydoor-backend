const f = require('../../src/lib/leadHygiene');

const day = (n) => new Date(Date.now() - n * 86_400_000);
const partnerLead = { id: 'p1', refCode: 'RD-L-000001', propertyId: 'prop1', buyerPhone: '+919000000001', addedByPartnerId: 'A', createdAt: day(3) };
const own = (over = {}) => ({ id: 'c1', refCode: 'RD-L-000002', propertyId: 'prop1', buyerPhone: '+919000000001', addedByPartnerId: null, status: 'UNASSIGNED', createdAt: day(1), escrowTransactions: [], ...over });

describe('duplicatesOfPartnerLead: the buyer\'s own enquiry that folds into a partner\'s registration', () => {
  test('same buyer, same property, made after, untouched: a duplicate', () => {
    expect(f.duplicatesOfPartnerLead(partnerLead, [own()]).map((d) => d.id)).toEqual(['c1']);
    expect(f.duplicatesOfPartnerLead(partnerLead, [own({ status: 'ASSIGNED' })])).toHaveLength(1);
  });
  test.each([
    ['another property', { propertyId: 'prop2' }],
    ['another number', { buyerPhone: '+919000000002' }],
    ['it is the partner\'s own lead', { addedByPartnerId: 'B' }],
    ['made before the partner registered the buyer', { createdAt: day(9) }],
    ['a visit is already booked', { siteVisitScheduledAt: day(0) }],
    ['the visit is verified', { isOtpVerified: true }],
    ['a token has been paid', { escrowTransactions: [{ id: 'e1' }] }],
    ['already closed or dropped', { status: 'DROPPED' }],
    ['already with a site visit done', { status: 'SITE_VISIT_DONE' }],
    ['it is the same lead', { id: 'p1' }],
  ])('is left alone when %s', (_n, over) => {
    expect(f.duplicatesOfPartnerLead(partnerLead, [own(over)])).toEqual([]);
  });
});

describe('reassignCheck: moving a lead to another partner', () => {
  const lead = (over = {}) => ({ assignedPartnerId: 'P1', status: 'ASSIGNED', isOtpVerified: false, siteVisitScheduledAt: null, ...over });
  test('an unvisited lead moves freely', () => expect(f.reassignCheck(lead(), [])).toEqual({ ok: true, clearVisit: false }));
  test('a lead nobody holds is not a reassignment at all', () => expect(f.reassignCheck({ assignedPartnerId: null, status: 'UNASSIGNED' }, [])).toMatchObject({ ok: true }));
  test.each(['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'RELEASED', 'PARTIALLY_REFUNDED'])('blocked while a token is %s', (status) => {
    expect(f.reassignCheck(lead(), [{ status }])).toMatchObject({ ok: false, code: 'REASSIGN_BLOCKED_MONEY' });
  });
  test.each(['REFUNDED', 'CANCELLED', 'FAILED', 'PAYMENT_PENDING'])('a %s token does not block it', (status) => {
    expect(f.reassignCheck(lead(), [{ status }]).ok).toBe(true);
  });
  test('blocked once the buyer has met the partner', () => {
    expect(f.reassignCheck(lead({ isOtpVerified: true }), [])).toMatchObject({ ok: false, code: 'REASSIGN_BLOCKED_VISIT_DONE' });
    expect(f.reassignCheck(lead({ status: 'SITE_VISIT_DONE' }), [])).toMatchObject({ ok: false, code: 'REASSIGN_BLOCKED_VISIT_DONE' });
  });
  test('a booked visit needs a reason, and the booking is then cleared', () => {
    const booked = lead({ status: 'SITE_VISIT_SCHEDULED', siteVisitScheduledAt: day(-2) });
    expect(f.reassignCheck(booked, [])).toMatchObject({ ok: false, code: 'REASSIGN_REASON_REQUIRED' });
    expect(f.reassignCheck(booked, [], 'abc')).toMatchObject({ ok: false, code: 'REASSIGN_REASON_REQUIRED' });
    expect(f.reassignCheck(booked, [], '  Partner is unreachable ')).toEqual({ ok: true, clearVisit: true });
  });
});

describe('drop reason codes', () => {
  test('every code has a label an admin can read', () => {
    expect(f.DROP_REASON_CODES.length).toBeGreaterThan(5);
    for (const c of f.DROP_REASON_CODES) expect(f.DROP_REASON_LABEL[c]).toMatch(/\w/);
  });
});
