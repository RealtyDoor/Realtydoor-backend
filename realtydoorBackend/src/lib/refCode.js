'use strict';

const prisma = require('./prisma');

const PREFIXES = { user: 'RD-U-', lead: 'RD-L-' };

// Atomic via Mongo's $inc (not the aggregation-$add path that evaluates to
// null on a missing field — this field always exists once the counter row
// is created, so a plain increment is safe). upsert covers "counter doesn't
// exist yet" for a brand-new kind; in steady state (after
// scripts/backfillRefCodes.js has pre-seeded both rows) this is always a
// plain atomic update.
async function nextRefCode(kind) {
  const counter = await prisma.counter.upsert({
    where: { id: kind },
    update: { seq: { increment: 1 } },
    create: { id: kind, seq: 1 },
  });
  return `${PREFIXES[kind]}${String(counter.seq).padStart(6, '0')}`;
}

module.exports = { nextRefCode };
