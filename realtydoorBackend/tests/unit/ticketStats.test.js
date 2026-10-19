const { averageResolutionDays } = require('../../src/lib/ticketStats');

const day = 86_400_000;
const at = (n) => new Date(1_700_000_000_000 + n * day);

describe('averageResolutionDays', () => {
  test('averages created -> resolved in days', () => {
    expect(averageResolutionDays([
      { createdAt: at(0), resolvedAt: at(2) },
      { createdAt: at(0), resolvedAt: at(4) },
    ])).toBe(3);
  });

  test('ignores rows whose resolvedAt is before createdAt instead of going negative', () => {
    expect(averageResolutionDays([
      { createdAt: at(0), resolvedAt: at(2) },
      { createdAt: at(30), resolvedAt: at(10) },
    ])).toBe(2);
  });

  test('is 0 with nothing usable', () => {
    expect(averageResolutionDays([])).toBe(0);
    expect(averageResolutionDays([{ createdAt: at(5), resolvedAt: at(1) }])).toBe(0);
  });
});
