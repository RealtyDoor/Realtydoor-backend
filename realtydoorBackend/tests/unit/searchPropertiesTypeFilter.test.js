jest.mock('../../src/lib/prisma', () => ({
  property: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
}));
const prisma = require('../../src/lib/prisma');
const { searchProperties } = require('../../src/modules/properties/properties.service');

beforeEach(() => jest.clearAllMocks());

test('every property type the owner listed is accepted by the search filter', async () => {
  for (const t of ['FLAT', 'INDEPENDENT_HOUSE', 'VILLA', 'PLOT', 'COMMERCIAL_OFFICE', 'RETAIL_SHOP', 'INDUSTRIAL', 'WAREHOUSE', 'AGRICULTURAL', 'NEW_PROJECT']) {
    await searchProperties({ propertyType: t }, 0, 10, 1);
    expect(prisma.property.findMany.mock.calls.pop()[0].where.propertyType).toBe(t);
  }
});

test('a made-up propertyType or listingType is a 400 that names the allowed values, not a 500', async () => {
  await expect(searchProperties({ propertyType: 'COMMERCIAL' }, 0, 10, 1)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('COMMERCIAL_OFFICE') });
  await expect(searchProperties({ listingType: 'BOGUS' }, 0, 10, 1)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('SALE') });
  expect(prisma.property.findMany).not.toHaveBeenCalled();
});
