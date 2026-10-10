// Backend gaps handoff, 2026-10-10 (#7C) — one-off migration: collapse the
// known city-name variants already in the data (Bangalore/Bangaluru/
// Banglore -> Bengaluru) to the canonical spelling. Safe to re-run — rows
// already canonical are simply not matched by the variant list and left
// untouched. Run once, then write-time canonicalization (createProperty/
// updateProperty, upsertLocality) and the query-time alias safety net keep
// things from drifting again.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { CITY_ALIAS_GROUPS } = require('../src/lib/cityAlias');

async function run() {
  for (const group of CITY_ALIAS_GROUPS) {
    const nonCanonicalVariants = group.variants.filter((v) => v !== group.canonical);

    for (const model of ['property', 'localityInsight']) {
      const matches = await prisma[model].findMany({
        where: { OR: nonCanonicalVariants.map((v) => ({ city: { equals: v, mode: 'insensitive' } })) },
        select: { id: true, city: true },
      });
      if (!matches.length) {
        console.log(`[${model}] no rows to fix for ${group.canonical}`);
        continue;
      }
      console.log(`[${model}] fixing ${matches.length} row(s) -> "${group.canonical}":`,
        [...new Set(matches.map((m) => m.city))]);
      for (const row of matches) {
        try {
          await prisma[model].update({ where: { id: row.id }, data: { city: group.canonical } });
        } catch (err) {
          // LocalityInsight has a unique (city, locality) pair — a row for
          // the same locality already exists under the canonical spelling.
          // Flagged for manual merge rather than silently dropped or
          // crashing the rest of the migration.
          console.error(`[${model}] could not canonicalize row ${row.id} (was "${row.city}") — likely a duplicate under "${group.canonical}":`, err.message);
        }
      }
    }
  }
  console.log('Done.');
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
