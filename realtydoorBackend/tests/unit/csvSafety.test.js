const { csvCell } = require('../../src/modules/money/ledger.service');

describe('csvCell: spreadsheet formula safety', () => {
  test.each(['=1+1', '=HYPERLINK("http://evil","x")', '+cmd|calc', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '=cmd|\' /C calc\'!A0'])(
    'neutralises the formula-like text %j',
    (v) => { expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/); },
  );

  test('leaves negative amounts and phone numbers alone so the accountant\'s numbers stay numbers', () => {
    expect(csvCell('-120.00')).toBe('-120.00');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('+919000000099')).toBe('+919000000099');
    expect(csvCell('1209.50')).toBe('1209.50');
  });

  test('still quotes commas, quotes and new lines, and handles empty values', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  test('a formula that also needs quoting is both neutralised and quoted', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });
});
