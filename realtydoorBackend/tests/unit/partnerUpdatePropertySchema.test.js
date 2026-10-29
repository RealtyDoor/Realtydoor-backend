const { updatePropertySchema } = require('../../src/modules/properties/properties.validator');

describe('partner update property schema', () => {
  it('accepts the fields the partner form can now edit', () => {
    const out = updatePropertySchema.parse({
      title: 'Plot near Hoskote', description: 'A well located residential plot close to the highway.',
      balconies: 2, unitsLeft: 5, floorPlanUrl: 'https://s3.example/plan.pdf', virtualTourUrl: 'https://tour.example/x', videoUrl: 'https://video.example/y',
      locality: 'Hoskote', city: 'Bengaluru', amenities: ['Park'], reraNumber: 'PRM/KA/1',
    });
    expect(out.balconies).toBe(2);
    expect(out.locality).toBe('Hoskote');
  });

  it('lets the partner clear an optional field with null', () => {
    const out = updatePropertySchema.parse({ virtualTourUrl: null, reraNumber: null, possessionDate: null, mortgageLender: null });
    expect(out).toEqual({ virtualTourUrl: null, reraNumber: null, possessionDate: null, mortgageLender: null });
  });

  it('does not let a required field be cleared', () => {
    expect(() => updatePropertySchema.parse({ title: null })).toThrow();
    expect(() => updatePropertySchema.parse({ locality: null })).toThrow();
    expect(() => updatePropertySchema.parse({ pincode: null })).toThrow();
  });

  it('drops admin-only fields instead of accepting them from a partner', () => {
    const out = updatePropertySchema.parse({ title: 'Valid title here', isFeatured: true, isVerified: true, publishStatus: 'APPROVED', adminEditNote: 'x', partnerId: 'u9', slug: 's' });
    expect(out).toEqual({ title: 'Valid title here' });
  });

  it('still validates values', () => {
    expect(() => updatePropertySchema.parse({ pincode: '123' })).toThrow();
    expect(() => updatePropertySchema.parse({ floorPlanUrl: 'nope' })).toThrow();
    expect(() => updatePropertySchema.parse({ balconies: -1 })).toThrow();
  });

  it('accepts a reordered or shortened photo list and a cover index', () => {
    const out = updatePropertySchema.parse({ images: ['https://s3.example/b.png', 'https://s3.example/a.png'], coverImageIndex: 1, videos: [] });
    expect(out.images).toHaveLength(2);
    expect(out.coverImageIndex).toBe(1);
  });

  it('refuses a cover index past the photos, and non-link photo entries', () => {
    expect(() => updatePropertySchema.parse({ images: ['https://s3.example/a.png'], coverImageIndex: 4 })).toThrow();
    expect(() => updatePropertySchema.parse({ images: ['not a link'] })).toThrow();
  });
});
