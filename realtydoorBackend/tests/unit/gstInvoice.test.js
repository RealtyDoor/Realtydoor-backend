const { splitGstInclusive, financialYear, formatInvoiceNo } = require('../../src/lib/gstInvoice');

describe('splitGstInclusive', () => {
  test('Rs. 1,209 with 18% GST included is Rs. 1,024.58 plus Rs. 184.42, split evenly', () => {
    expect(splitGstInclusive(120900)).toEqual({ taxablePaise: 102458, cgstPaise: 9221, sgstPaise: 9221, totalPaise: 120900 });
  });
  test('taxable plus tax always equals what was paid, with the odd paisa on SGST', () => {
    for (const paise of [1, 99, 118, 119, 12345, 120901, 5120900, 987654321]) {
      const s = splitGstInclusive(paise);
      expect(s.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(paise);
      expect(s.sgstPaise - s.cgstPaise).toBeGreaterThanOrEqual(0);
      expect(s.sgstPaise - s.cgstPaise).toBeLessThanOrEqual(1);
    }
  });
  test('a different GST rate and a zero or missing fee behave', () => {
    expect(splitGstInclusive(11800, 18).taxablePaise).toBe(10000);
    expect(splitGstInclusive(10500, 5).taxablePaise).toBe(10000);
    expect(splitGstInclusive(0)).toEqual({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0 });
    expect(splitGstInclusive(undefined).totalPaise).toBe(0);
  });
});

describe('financialYear', () => {
  test('April starts a new year, March ends the old one', () => {
    expect(financialYear(new Date(2026, 3, 1))).toBe('26-27');
    expect(financialYear(new Date(2026, 9, 22))).toBe('26-27');
    expect(financialYear(new Date(2027, 2, 31))).toBe('26-27');
    expect(financialYear(new Date(2026, 2, 31))).toBe('25-26');
  });
});

describe('formatInvoiceNo', () => {
  test('is padded, per financial year, and at most 16 characters', () => {
    expect(formatInvoiceNo('26-27', 1)).toBe('RD/26-27/00001');
    expect(formatInvoiceNo('26-27', 123456).length).toBeLessThanOrEqual(16);
  });
});
