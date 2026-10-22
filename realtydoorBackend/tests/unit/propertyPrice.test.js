const { missingPriceMessage } = require('../../src/modules/properties/properties.validator');

describe('createProperty price rule (T25)', () => {
  it('rejects a sale listing with no price', () => {
    expect(missingPriceMessage({ listingType: 'SALE' })).toMatch(/Price is required/);
    expect(missingPriceMessage({ listingType: 'SALE', price: 0 })).toMatch(/Price is required/);
  });
  it('accepts a sale listing with a price', () => {
    expect(missingPriceMessage({ listingType: 'SALE', price: 5000000 })).toBeNull();
  });
  it('rent and lease need a monthly rent (or price)', () => {
    expect(missingPriceMessage({ listingType: 'RENT' })).toMatch(/Monthly rent/);
    expect(missingPriceMessage({ listingType: 'LEASE', monthlyRent: 20000 })).toBeNull();
  });
});
