// ?city=a&city=b reaches the alias helpers as an array; they called .trim() on it and answered 500 on five public locality endpoints.
const { canonicalizeCity, cityAliasQueryGroup } = require('../../src/lib/cityAlias');

test('known spellings still map to the canonical city, ignoring case and spaces', () => {
  expect(canonicalizeCity('  bengaluru ')).toBe(canonicalizeCity('Bangalore'));
  expect(cityAliasQueryGroup('Bangalore').length).toBeGreaterThan(1);
});
test('an unknown city is returned unchanged', () => {
  expect(canonicalizeCity('Pune')).toBe('Pune');
  expect(cityAliasQueryGroup('Pune')).toEqual(['Pune']);
});
test('empty input passes through as before', () => {
  expect(canonicalizeCity('')).toBe('');
  expect(cityAliasQueryGroup(undefined)).toEqual([undefined]);
});
test.each([[['Bangalore', 'Pune']], [42], [true], [{ a: 1 }]])('a non-text city (%j) is a 400, not a TypeError', (bad) => {
  expect(() => canonicalizeCity(bad)).toThrow(expect.objectContaining({ statusCode: 400 }));
  expect(() => cityAliasQueryGroup(bad)).toThrow(expect.objectContaining({ statusCode: 400 }));
});
