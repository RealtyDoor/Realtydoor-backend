jest.mock('../../src/lib/prisma', () => ({
  localityInsight: { findMany: jest.fn() },
  property: { groupBy: jest.fn() },
}));
jest.mock('../../src/lib/cache', () => ({ withCache: (_key, _ttl, fn) => fn(), cacheDel: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/pdfReport', () => ({ buildLocalityReportPdf: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const service = require('../../src/modules/locality/locality.service');

describe('the public locality list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.property.groupBy.mockResolvedValue([{ city: 'Bengaluru', locality: 'Jigani', _count: { _all: 2 } }]);
  });

  test('asks the database for the rental yield and returns it, so the home page can show the best-yield locality', async () => {
    prisma.localityInsight.findMany.mockResolvedValue([
      { city: 'Bengaluru', locality: 'Jigani', avgPricePerSqftPaise: 565000, priceChangeLastMonthPct: 0.4, priceTrends: { growth: { oneYear: 7.5 } }, localityScore: 7, subtitle: 's', avgRentYieldPct: 4.2 },
      { city: 'Bengaluru', locality: 'Hoskote', avgPricePerSqftPaise: 675000, priceTrends: null, localityScore: null, avgRentYieldPct: undefined },
    ]);
    const rows = await service.getLocalitiesList();
    expect(prisma.localityInsight.findMany.mock.calls[0][0].select.avgRentYieldPct).toBe(true);
    expect(rows.find((r) => r.locality === 'Jigani')).toMatchObject({ avgRentYieldPct: 4.2, priceChangeOneYearPct: 7.5, listingsCount: 2 });
    // a locality whose report has no yield gives null, never a made-up number
    expect(rows.find((r) => r.locality === 'Hoskote')).toMatchObject({ avgRentYieldPct: null, priceChangeOneYearPct: null, listingsCount: 0 });
  });
});
