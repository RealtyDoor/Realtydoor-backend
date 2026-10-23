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
    expect(financialYear(new Date('2026-04-01T12:00:00+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2026-10-22T12:00:00+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2027-03-31T12:00:00+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2026-03-31T12:00:00+05:30'))).toBe('25-26');
  });
  test('is read in India time whatever zone the server runs in', () => {
    // 00:30 IST on 1 April is still 31 March in UTC: it must be the new year.
    expect(financialYear(new Date('2026-04-01T00:30:00+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('25-26');
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('26-27');
    // 23:45 IST on 31 March is 18:15 UTC the same day: still the old year.
    expect(financialYear(new Date('2027-03-31T23:45:00+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2027-04-01T00:05:00+05:30'))).toBe('27-28');
  });
});

describe('formatInvoiceNo', () => {
  test('is padded, per financial year, and at most 16 characters', () => {
    expect(formatInvoiceNo('26-27', 1)).toBe('RD/26-27/00001');
    expect(formatInvoiceNo('26-27', 123456).length).toBeLessThanOrEqual(16);
  });
});

describe('splitGstInclusive: odd inputs', () => {
  test('text numbers, floats and negatives never produce a NaN or a negative tax', () => {
    expect(splitGstInclusive('120900').totalPaise).toBe(120900);
    expect(splitGstInclusive(120900.4).totalPaise).toBe(120900);
    for (const bad of [NaN, -5, null, Infinity, -Infinity, 'abc', {}, []]) {
      const s = splitGstInclusive(bad);
      for (const v of Object.values(s)) expect(Number.isFinite(v) && v >= 0).toBe(true);
    }
  });

  test('a very large amount keeps taxable + tax equal to the total', () => {
    const s = splitGstInclusive(99_999_999_999);
    expect(s.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(99_999_999_999);
  });

  test('a one-paisa fee has no tax, rather than a negative or fractional one', () => {
    expect(splitGstInclusive(1)).toEqual({ taxablePaise: 1, cgstPaise: 0, sgstPaise: 0, totalPaise: 1 });
  });
});

describe('financialYear and invoice numbers: edges', () => {
  test('the last second of March and the first of April', () => {
    expect(financialYear(new Date('2027-03-31T23:59:59+05:30'))).toBe('26-27');
    expect(financialYear(new Date('2027-04-01T00:00:00+05:30'))).toBe('27-28');
  });
  test('a century boundary keeps two digits', () => {
    expect(financialYear(new Date('2099-06-01T12:00:00+05:30'))).toBe('99-00');
  });
  test('the sequence pads to five digits and grows past it without breaking the 16-character limit until 99,999 invoices', () => {
    expect(formatInvoiceNo('26-27', 99999)).toBe('RD/26-27/99999');
    expect(formatInvoiceNo('26-27', 99999).length).toBeLessThanOrEqual(16);
    expect(formatInvoiceNo('26-27', 100000)).toBe('RD/26-27/100000');
  });
});
