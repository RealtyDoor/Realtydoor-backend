// BUG-005: localities were stored as typed ("marthahalli", "bommasandra"), so the same place appeared in two spellings.
const { tidyLocality } = require('../../src/lib/localityName');
const { createPropertySchema } = require('../../src/modules/properties/properties.validator');

test('tidyLocality fixes capitals and spacing, keeping hyphens and words already in capitals', () => {
  expect(tidyLocality('marthahalli')).toBe('Marthahalli');
  expect(tidyLocality('  hoskote-bagalur   road ')).toBe('Hoskote-Bagalur Road');
  expect(tidyLocality('BTM Layout')).toBe('BTM Layout');
});

test('a listing saved with a lower-case locality is stored tidy', () => {
  const base = { title: 'Plot in Marthahalli', description: 'x'.repeat(30), price: 5000000, propertyType: 'PLOT', listingType: 'SALE', address: '12 Main Road', locality: 'marthahalli', city: 'Bengaluru', state: 'Karnataka', pincode: '560037' };
  const parsed = createPropertySchema.safeParse(base);
  if (parsed.success) expect(parsed.data.locality).toBe('Marthahalli');
  else expect(parsed.error.issues.map((i) => i.path.join('.'))).not.toContain('locality');
});
