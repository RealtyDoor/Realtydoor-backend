const { isVisitTooEarly } = require('../../src/lib/visitWindow');

const h = 3_600_000;
const slot = new Date('2026-10-20T09:30:00Z');

describe('isVisitTooEarly', () => {
  test('rejects verification well before the slot', () => {
    expect(isVisitTooEarly(slot, slot.getTime() - 29 * h)).toBe(true);
  });
  test('allows it inside the window and after the slot', () => {
    expect(isVisitTooEarly(slot, slot.getTime() - 1 * h)).toBe(false);
    expect(isVisitTooEarly(slot, slot.getTime() + 5 * h)).toBe(false);
  });
  test('honours a custom window', () => {
    expect(isVisitTooEarly(slot, slot.getTime() - 3 * h, 4)).toBe(false);
    expect(isVisitTooEarly(slot, slot.getTime() - 5 * h, 4)).toBe(true);
  });
  test('no scheduled time or an invalid one never blocks', () => {
    expect(isVisitTooEarly(null)).toBe(false);
    expect(isVisitTooEarly('garbage')).toBe(false);
  });
});
