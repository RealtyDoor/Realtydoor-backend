const { throwForDuplicateKey } = require('../../src/modules/microsites/microsite.errors');
const { slugSchema, createMicrositeSchema, updateMicrositeSchema, RESERVED_SLUGS } = require('../../src/modules/microsites/microsite.validator');

describe('slugSchema', () => {
  test('lowercases before validating — a mixed-case slug is accepted and normalized', () => {
    expect(slugSchema.parse('Whitefield-3BHK-Villa')).toBe('whitefield-3bhk-villa');
  });

  test('rejects a slug shorter than 3 characters', () => {
    expect(() => slugSchema.parse('ab')).toThrow();
  });

  test('rejects a slug longer than 60 characters', () => {
    expect(() => slugSchema.parse('a'.repeat(61))).toThrow();
  });

  test('rejects spaces, underscores and double hyphens', () => {
    expect(() => slugSchema.parse('not a slug')).toThrow();
    expect(() => slugSchema.parse('not_a_slug')).toThrow();
    expect(() => slugSchema.parse('not--a-slug')).toThrow();
  });

  test.each(RESERVED_SLUGS)('rejects the reserved word "%s"', (word) => {
    expect(() => slugSchema.parse(word)).toThrow(/reserved word/);
  });

  test('rejects a reserved word regardless of case, since it is lowercased first', () => {
    expect(() => slugSchema.parse('ADMIN')).toThrow(/reserved word/);
  });
});

describe('createMicrositeSchema', () => {
  test('requires both propertyId and slug', () => {
    expect(() => createMicrositeSchema.parse({})).toThrow();
    expect(() => createMicrositeSchema.parse({ slug: 'villa-x' })).toThrow();
  });

  test('accepts a valid propertyId + slug pair', () => {
    const data = createMicrositeSchema.parse({ propertyId: '507f1f77bcf86cd799439011', slug: 'Villa-X' });
    expect(data).toEqual({ propertyId: '507f1f77bcf86cd799439011', slug: 'villa-x' });
  });
});

describe('updateMicrositeSchema', () => {
  test('rejects an empty body — at least one field is required', () => {
    expect(() => updateMicrositeSchema.parse({})).toThrow(/At least one field/);
  });

  test('accepts enabled alone', () => {
    expect(updateMicrositeSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  test('accepts slug alone, normalized', () => {
    expect(updateMicrositeSchema.parse({ slug: 'Villa-X' })).toEqual({ slug: 'villa-x' });
  });
});

describe('throwForDuplicateKey', () => {
  test('maps a slug unique-constraint violation to 409 SLUG_TAKEN', () => {
    expect(() => throwForDuplicateKey({ meta: { target: ['slug'] } }))
      .toThrow(/already taken/);
    try {
      throwForDuplicateKey({ meta: { target: ['slug'] } });
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.data).toEqual({ code: 'SLUG_TAKEN' });
    }
  });

  test('maps a propertyId unique-constraint violation to 409 MICROSITE_EXISTS', () => {
    expect(() => throwForDuplicateKey({ meta: { target: ['propertyId'] } }))
      .toThrow(/already has a microsite/);
    try {
      throwForDuplicateKey({ meta: { target: ['propertyId'] } });
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.data).toEqual({ code: 'MICROSITE_EXISTS' });
    }
  });

  test('handles target given as an index-name string instead of a field array', () => {
    expect(() => throwForDuplicateKey({ meta: { target: 'Microsite_slug_key' } }))
      .toThrow(/already taken/);
  });

  test('falls back to a generic 409 when the target is missing or unrecognized', () => {
    try {
      throwForDuplicateKey({ meta: {} });
    } catch (err) {
      expect(err.statusCode).toBe(409);
    }
  });
});
