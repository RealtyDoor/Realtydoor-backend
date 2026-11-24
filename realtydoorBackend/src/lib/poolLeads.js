'use strict';

// The qualification pool: bulk-imported leads (the old CRM, events, bought lists) wait here, OUT of every live queue, until a person releases
// them. One definition, used everywhere, so a screen or job cannot forget it:
//   in the pool  = poolBatch is set AND poolReleasedAt is empty
//   live         = everything else (every normal lead has no poolBatch)

/** Prisma condition: leads that are NOT waiting in the pool. Add it to every list, count, job and alert that means "live leads". */
const LIVE_LEADS = { OR: [{ poolBatch: { isSet: false } }, { poolReleasedAt: { isSet: true } }] };

/** Prisma condition: leads waiting in the pool (optionally one batch / one group). */
function inPool({ batch, group } = {}) {
  return {
    poolBatch: batch ? batch : { isSet: true },
    poolReleasedAt: { isSet: false },
    ...(group ? { poolGroup: group } : {}),
  };
}

/** Same rule for an object already in memory. */
const isInPool = (lead) => !!lead && !!lead.poolBatch && !lead.poolReleasedAt;

/** The moment a lead's platform clocks start: when it entered the live flow (released from the pool, or created). */
const liveSince = (lead) => new Date(lead.poolReleasedAt || lead.createdAt);

/** Add LIVE_LEADS to an existing where without losing what it already had. */
function onlyLive(where = {}) {
  return where.AND ? { ...where, AND: [...(Array.isArray(where.AND) ? where.AND : [where.AND]), LIVE_LEADS] } : { ...where, AND: [LIVE_LEADS] };
}

/** The pool batch name for leads that arrive through a "qualify first" source: the source's name and the month, e.g. "meta-lakeview-2026-11". */
function intakeBatch(sourceName, now = new Date()) {
  const slug = String(sourceName || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'source';
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return `${slug}-${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { LIVE_LEADS, inPool, isInPool, liveSince, onlyLive, intakeBatch };
