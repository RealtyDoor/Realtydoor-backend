const ApiError = require('../utils/ApiError');
// Backend gaps handoff, 2026-10-10 (#7C) — live data holds Bengaluru,
// bangalore, bangaluru and banglore as four distinct strings, which
// fragmented search (city=Bangalore missed everything stored as Bengaluru),
// the city-count summary, and locality insights. One canonical spelling,
// with every known variant collapsing into it both at write time
// (canonicalizeCity, called from createProperty/updateProperty and
// upsertLocality) and as a query-time safety net (cityAliasQueryGroup) for
// whatever hasn't been migrated yet or ever gets written off-path.
const CITY_ALIAS_GROUPS = [
  { canonical: 'Bengaluru', variants: ['Bengaluru', 'Bangalore', 'Bangaluru', 'Banglore'] },
];

const VARIANT_TO_CANONICAL = new Map();
for (const group of CITY_ALIAS_GROUPS) {
  for (const variant of group.variants) {
    VARIANT_TO_CANONICAL.set(variant.toLowerCase(), group.canonical);
  }
}

function canonicalizeCity(city) {
  if (!city) return city;
  // ?city=a&city=b arrives as an array; that is the caller's mistake (400), not a crash (500).
  if (typeof city !== 'string') throw new ApiError(400, 'city must be a single value');
  return VARIANT_TO_CANONICAL.get(city.trim().toLowerCase()) ?? city;
}

// The set of spellings to OR-match against for a given requested city — the
// full alias group if it's a known one, otherwise just the input itself
// unchanged (so an unrelated city name isn't affected).
function cityAliasQueryGroup(city) {
  if (!city) return [city];
  if (typeof city !== 'string') throw new ApiError(400, 'city must be a single value');
  const canonical = canonicalizeCity(city);
  const group = CITY_ALIAS_GROUPS.find((g) => g.canonical === canonical);
  return group ? group.variants : [city];
}

module.exports = { canonicalizeCity, cityAliasQueryGroup, CITY_ALIAS_GROUPS };
