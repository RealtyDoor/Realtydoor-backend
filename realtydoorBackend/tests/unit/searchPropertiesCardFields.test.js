jest.mock('../../src/lib/prisma', () => ({
  property: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
}));
const prisma = require('../../src/lib/prisma');
const { searchProperties } = require('../../src/modules/properties/properties.service');

test('search results carry the fields a card needs for every property type', async () => {
  await searchProperties({}, 0, 10, 1);
  const { select } = prisma.property.findMany.mock.calls[0][0];
  // plots and new projects: size, units, layout, developer, configurations and the price range
  for (const field of ['plotArea', 'unitsLeft', 'totalUnits', 'landAreaValue', 'landAreaUnit', 'openSpacePct', 'developer', 'unitConfigurations', 'priceMax', 'possessionDate']) {
    expect(select[field]).toBe(true);
  }
  // homes and commercial
  for (const field of ['bhk', 'bathrooms', 'carpetArea', 'builtUpArea', 'facing', 'furnishing', 'floorNumber', 'totalFloors']) {
    expect(select[field]).toBe(true);
  }
});
