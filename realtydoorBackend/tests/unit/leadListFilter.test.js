// 23 Nov 2026: the admin leads list filters by status (one or several) and searches across ALL leads, phone included.
const { leadListFilter: rawFilter } = require('../../src/lib/leadListFilter');
const { LIVE_LEADS } = require('../../src/lib/poolLeads');
// Every list is live leads only (qualification pool); these tests are about the other conditions, so that one is taken out and tested on its own below.
function leadListFilter(q, now) {
  const w = rawFilter(q, now);
  if (!w.AND) return w;
  const rest = w.AND.filter((c) => c !== LIVE_LEADS);
  const { AND: _a, ...others } = w;
  if (rest.length === 1 && rest[0].OR && rest[0].OR[0].refCode && !others.OR) return { ...others, OR: rest[0].OR };
  return rest.length ? { ...others, AND: rest } : others;
}

describe('status', () => {
  test('one status', () => expect(leadListFilter({ status: 'UNASSIGNED' }).status).toBe('UNASSIGNED'));
  test('several, comma-separated (the "In progress" chip)', () => {
    expect(leadListFilter({ status: 'SITE_VISIT_SCHEDULED,SITE_VISIT_DONE' }).status).toEqual({ in: ['SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE'] });
  });
  test('a repeated query parameter works too', () => {
    expect(leadListFilter({ status: ['CLOSED', 'DROPPED'] }).status).toEqual({ in: ['CLOSED', 'DROPPED'] });
  });
  test('unknown values are dropped; only unknown values match nothing (never everything)', () => {
    expect(leadListFilter({ status: 'CLOSED,BOGUS' }).status).toBe('CLOSED');
    expect(leadListFilter({ status: '{"$ne":null}' }).status).toEqual({ in: [] });
  });
  test('no status means no status condition', () => expect(leadListFilter({})).toEqual({}));
});

describe('search', () => {
  const fields = (w) => w.OR.map((c) => Object.keys(c)[0]);
  test('text searches reference, name and email', () => {
    expect(fields(leadListFilter({ search: 'Ravi' }))).toEqual(['refCode', 'buyerName', 'buyerEmail']);
  });
  test('a reference with digits is not mistaken for a phone', () => {
    expect(fields(leadListFilter({ search: 'RD-L-000165' }))).not.toContain('buyerPhone');
  });
  test('digits search the phone (last 10)', () => {
    const w = leadListFilter({ search: '+91 98765 43210' });
    expect(w.OR).toContainEqual({ buyerPhone: { contains: '9876543210' } });
    expect(leadListFilter({ search: '3210' }).OR).toContainEqual({ buyerPhone: { contains: '3210' } });
  });
  test('two digits are too few for a phone search', () => expect(fields(leadListFilter({ search: '32' }))).not.toContain('buyerPhone'));
  test('blank search adds nothing', () => expect(leadListFilter({ search: '   ' })).toEqual({}));
});

describe('Lead Monitor filters', () => {
  const now = Date.UTC(2026, 10, 23);
  test('stalled: open and not updated for 3 days', () => {
    const w = leadListFilter({ stalled: '1' }, now);
    expect(w.AND).toEqual([{ status: { in: ['UNASSIGNED', 'ASSIGNED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE'] } }, { updatedAt: { lt: new Date(now - 3 * 86400000) } }]);
  });
  test('city matches the lead or its listing', () => {
    expect(leadListFilter({ city: 'Bengaluru' }).AND).toEqual([{ OR: [{ city: 'Bengaluru' }, { property: { city: 'Bengaluru' } }] }]);
  });
  test('search and city together do not overwrite each other', () => {
    const w = leadListFilter({ search: 'Ravi', city: 'Bengaluru' });
    expect(w.AND).toHaveLength(2);
    expect(w.OR).toBeUndefined();
  });
});

describe('merged with the sales filters (admin list path)', () => {
  jest.mock('../../src/lib/prisma', () => ({}));
  test('a city filter and a sales filter both survive', () => {
    const { listWhere } = require('../../src/modules/leadSales/leadSales.service');
    const owner = { id: 'a1', role: 'ADMIN', staffRole: null, adminPermissions: [] };
    const w = listWhere({ city: 'Bengaluru', dropRequested: '1' }, owner);
    expect(w.AND).toEqual(expect.arrayContaining([{ OR: [{ city: 'Bengaluru' }, { property: { city: 'Bengaluru' } }] }, { dropRequestedByPartner: true }]));
  });
});

describe('the qualification pool', () => {
  test('lists are live leads only by default', () => expect(rawFilter({}).AND).toContainEqual(LIVE_LEADS));
  test('pool=1 shows only unreleased pool leads, optionally one batch and group', () => {
    const w = rawFilter({ pool: '1', batch: 'b1', group: 'A' });
    expect(w.AND).toContainEqual({ poolBatch: 'b1', poolReleasedAt: { isSet: false }, poolGroup: 'A' });
    expect(w.AND).not.toContainEqual(LIVE_LEADS);
  });
  test('an unknown group is ignored', () => expect(rawFilter({ pool: '1', group: 'Z' }).AND).toContainEqual({ poolBatch: { isSet: true }, poolReleasedAt: { isSet: false } }));
});
