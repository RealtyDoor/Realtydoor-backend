const { editPropertySchema } = require('../../src/modules/admin/admin.validator');

const full = {
  title: 'Brigade Plot, Hoskote', description: 'A well located residential plot close to the highway.',
  price: 7500000, previousPrice: 7800000, monthlyRent: null, priceNegotiable: true,
  propertyType: 'PLOT', listingType: 'SALE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'APPROVED',
  rejectionNote: null, adminEditNote: 'Corrected locality to match the CMS report',
  bhk: null, bathrooms: null, balconies: null, carpetArea: null, builtUpArea: null, plotArea: 1200,
  floorNumber: null, totalFloors: null, ageOfProperty: 0, furnishing: null, facing: 'East', possessionDate: '2026-12-01T00:00:00.000Z',
  unitsLeft: 12, developer: 'Aashrithaa', landAreaValue: 4, landAreaUnit: 'acres', openSpacePct: 40, totalUnits: 120,
  address: '12, Hoskote Bagalur Road', locality: 'Hoskote', city: 'Bengaluru', state: 'Karnataka', pincode: '562114',
  latitude: 13.07, longitude: 77.79, nearbyLandmarks: ['Hoskote toll plaza'], mapLink: 'https://maps.app.goo.gl/abc',
  reraNumber: 'PRM/KA/RERA/1251/309/PR/123', bankApprovals: ['HDFC', 'SBI'], isMortgaged: false, mortgageLender: null,
  loanNocStatus: 'NOT_REQUIRED', loanNocUrl: null, hasCoOwners: false,
  images: ['https://s3.example/a.png', 'https://s3.example/b.png'], videos: [], coverImageIndex: 1,
  floorPlanUrl: null, virtualTourUrl: 'https://tour.example/x', videoUrl: null,
  amenities: ['Park', 'Gym'], societyFeatures: ['24x7 security'], metaTitle: 'Plots in Hoskote', metaDescription: 'Verified plots near Hoskote.',
  isFeatured: true, isFeaturedProject: false, isSearchable: true, isVerified: true, isB2BOnly: false, b2bUrgent: false, commissionSplitOffer: null,
};

describe('admin edit property schema', () => {
  it('accepts every editable listing field in one payload', () => {
    expect(() => editPropertySchema.parse(full)).not.toThrow();
  });

  it('accepts a single changed field', () => {
    expect(editPropertySchema.parse({ locality: 'Hoskote' })).toEqual({ locality: 'Hoskote' });
  });

  it('rejects an empty change', () => {
    expect(() => editPropertySchema.parse({})).toThrow();
  });

  it.each(['partnerId', 'slug', 'id', 'viewsThisWeek', 'createdAt', 'somethingMadeUp'])('rejects the unknown or protected field %s', (field) => {
    expect(() => editPropertySchema.parse({ title: 'Valid title', [field]: 'x' })).toThrow();
  });

  it('rejects bad values with a clear failure', () => {
    expect(() => editPropertySchema.parse({ pincode: '5621' })).toThrow();
    expect(() => editPropertySchema.parse({ propertyType: 'CASTLE' })).toThrow();
    expect(() => editPropertySchema.parse({ listingType: 'GIFT' })).toThrow();
    expect(() => editPropertySchema.parse({ openSpacePct: 140 })).toThrow();
    expect(() => editPropertySchema.parse({ latitude: 120 })).toThrow();
    expect(() => editPropertySchema.parse({ virtualTourUrl: 'not a url' })).toThrow();
    expect(() => editPropertySchema.parse({ metaTitle: 'x'.repeat(61) })).toThrow();
    expect(() => editPropertySchema.parse({ price: -5 })).toThrow();
    expect(() => editPropertySchema.parse({ bhk: 0 })).toThrow();
    expect(() => editPropertySchema.parse({ possessionDate: 'next year' })).toThrow();
  });

  it('lets optional fields be cleared with null, but not required ones', () => {
    expect(editPropertySchema.parse({ floorPlanUrl: null, monthlyRent: null, reraNumber: null }))
      .toEqual({ floorPlanUrl: null, monthlyRent: null, reraNumber: null });
    expect(() => editPropertySchema.parse({ title: null })).toThrow();
    expect(() => editPropertySchema.parse({ locality: null })).toThrow();
    expect(() => editPropertySchema.parse({ city: null })).toThrow();
  });

  it('refuses a cover photo index that points past the photo list', () => {
    expect(() => editPropertySchema.parse({ images: ['https://s3.example/a.png'], coverImageIndex: 3 })).toThrow();
    expect(() => editPropertySchema.parse({ images: ['https://s3.example/a.png'], coverImageIndex: 0 })).not.toThrow();
  });

  it('tidies the locality name the same way partner listings do', () => {
    const out = editPropertySchema.parse({ locality: '  hoskote   ' });
    expect(out.locality).toBe(out.locality.trim());
    expect(out.locality.length).toBeGreaterThan(0);
  });
});
