const { joinRejection } = require('../../src/lib/rejectionNote');

describe('joinRejection (B122)', () => {
  test('separates reason and note', () => {
    expect(joinRejection('Incomplete documents', 'Please re-upload the RERA certificate'))
      .toBe('Incomplete documents. Please re-upload the RERA certificate');
  });
  test('does not double up punctuation', () => {
    expect(joinRejection('Photos are blurry.', 'Retake them')).toBe('Photos are blurry. Retake them');
  });
  test('either alone, trimmed', () => {
    expect(joinRejection('  Duplicate listing ', undefined)).toBe('Duplicate listing');
    expect(joinRejection(undefined, 'Only a note')).toBe('Only a note');
    expect(joinRejection()).toBe('');
  });
});
