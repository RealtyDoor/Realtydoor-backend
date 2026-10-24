const prisma = require('./prisma');

// A short lock around "check, then create" so two requests arriving at the same instant cannot both pass the check (MongoDB
// has no partial unique index to do this for us). The lock is a Counter row whose _id is the key: creating it succeeds for one
// caller only. Its value is the time in seconds, so a lock left behind by a crashed process is taken over after `staleSeconds`.
// Works across several backend instances. Returns { busy: true } when someone else holds the key.
async function withKeyLock(key, fn, { staleSeconds = 30 } = {}) {
  const id = `lock:${key}`;
  const nowSec = () => Math.floor(Date.now() / 1000);
  let held = false;
  try {
    await prisma.counter.create({ data: { id, seq: nowSec() } });
    held = true;
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    // Held by someone: take it over only if it is stale (compare-and-set on the value we saw).
    const row = await prisma.counter.findUnique({ where: { id } });
    if (!row || nowSec() - row.seq < staleSeconds) return { busy: true };
    const took = await prisma.counter.updateMany({ where: { id, seq: row.seq }, data: { seq: nowSec() } });
    if (took.count !== 1) return { busy: true };
    held = true;
  }
  try {
    return { busy: false, value: await fn() };
  } finally {
    if (held) await prisma.counter.deleteMany({ where: { id } }).catch(() => null);
  }
}

module.exports = { withKeyLock };
