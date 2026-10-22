const c = require('../../src/lib/dataCleanup');

describe('guessPropertyType (B51)', () => {
  test.each([
    ['3BHK Apartment, Brigade Cosmopolis', 'FLAT'], ['3 BHK Flat in Baner', 'FLAT'], ['Sunrise Villa', 'VILLA'],
    ['Independent House in Jayanagar', 'INDEPENDENT_HOUSE'], ['Plot at Devanahalli', null], ['Brigade Cosmopolis', null], ['', null],
  ])('%s', (title, expected) => expect(c.guessPropertyType(title)).toBe(expected));
});

describe('planPropertyTypeFixes', () => {
  test('proposes a change only for a PLOT whose title clearly says something else', () => {
    const fixes = c.planPropertyTypeFixes([
      { id: '1', title: '3 BHK Flat in Baner', propertyType: 'PLOT' },
      { id: '2', title: 'Plot at Devanahalli', propertyType: 'PLOT' },
      { id: '3', title: 'Residential layout', propertyType: 'PLOT' },
      { id: '4', title: '2 BHK Flat', propertyType: 'FLAT' },
    ]);
    expect(fixes).toEqual([{ id: '1', title: '3 BHK Flat in Baner', from: 'PLOT', to: 'FLAT' }]);
  });
});

describe('QA services, junk tickets', () => {
  test('only active QA / retest services are listed', () => {
    const r = c.planQaServices([
      { id: 'a', name: 'QA Retest Service', price: 99, isActive: true },
      { id: 'b', name: 'QA Sample', price: 1, isActive: false },
      { id: 'c', name: 'Maintenance Premium', price: 4999, isActive: true },
      { id: 'd', name: 'Aqua Care', price: 100, isActive: true },
    ]);
    expect(r.map((s) => s.id)).toEqual(['a']);
  });
  test('only the known junk tickets that are still open are closed', () => {
    const r = c.planJunkTickets({
      partnerTickets: [{ id: 'p1', ticketNo: 'SUP-0009', subject: 'x', status: 'OPEN' }, { id: 'p2', ticketNo: 'SUP-0010', subject: 'y', status: 'CLOSED' }, { id: 'p3', ticketNo: 'SUP-0042', subject: 'real', status: 'OPEN' }],
      userTickets: [{ id: 'u1', subject: ' IOJQOIEW ', status: 'OPEN' }, { id: 'u2', subject: 'Tap leak', status: 'OPEN' }],
    });
    expect(r.partner.map((t) => t.id)).toEqual(['p1']);
    expect(r.user.map((t) => t.id)).toEqual(['u1']);
  });
});

describe('report-only finders', () => {
  test('orphaned partner, suspicious rent, placeholder description', () => {
    const props = [
      { id: '1', title: 'A', partnerId: 'gone', publishStatus: 'APPROVED', listingType: 'SALE' },
      { id: '2', title: 'B', partnerId: 'p1', listingType: 'RENT', monthlyRent: 12339900 },
      { id: '3', title: 'C', partnerId: 'p1', listingType: 'RENT', monthlyRent: 25000, description: `Only if... ${c.PLACEHOLDER_TEXT}.` },
    ];
    expect(c.findOrphanedProperties(props, ['p1']).map((p) => p.id)).toEqual(['1']);
    expect(c.findSuspiciousRents(props).map((p) => p.id)).toEqual(['2']);
    expect(c.findPlaceholderDescriptions(props).map((p) => p.id)).toEqual(['3']);
  });
});
