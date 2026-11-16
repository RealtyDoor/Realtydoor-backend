const prisma = require('./prisma');

// A short lock around "check, then create" so two requests arriving at the same instant cannot both pass the check (MongoDB
// has no partial unique index to do this for us). The lock is a Counter row whose _id is the key: creating it succeeds for one
// caller only. Its value is the time in seconds, so a lock left behind by a crashed process is taken over after `staleSeconds`.
// Works across several backend instances. Returns { busy: true } when someone else holds the key.
async function withKeyLock(key, fn, { staleSeconds = 30 } = {}) {
  const id = `lock:${key}`;
  const nowSec = () => Math.floor(Date.now() / 1000);
  let held = false;
  let mySeq = null; // what this holder wrote; cleanup deletes only a lock that still carries it (audit F15)
  try {
    mySeq = nowSec();
    await prisma.counter.create({ data: { id, seq: mySeq } });
    held = true;
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    // Held by someone: take it over only if it is stale (compare-and-set on the value we saw).
    const row = await prisma.counter.findUnique({ where: { id } });
    if (!row || nowSec() - row.seq < staleSeconds) return { busy: true };
    mySeq = nowSec();
    const took = await prisma.counter.updateMany({ where: { id, seq: row.seq }, data: { seq: mySeq } });
    if (took.count !== 1) return { busy: true };
    held = true;
  }
  try {
    return { busy: false, value: await fn() };
  } finally {
    // Audit Nov 2026 (F15). If the lock went stale and someone took it over, it carries their time and is left alone.
    if (held) await prisma.counter.deleteMany({ where: { id, seq: mySeq } }).catch(() => null);
  }
}

// The same lock, for work that should queue rather than be refused (several files uploaded at once to one record).
// Waits a little for the holder to finish; throws the given error if it never gets a turn.
async function withKeyLockWait(key, fn, { tries = 20, waitMs = 150, staleSeconds = 30, onBusy } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const r = await withKeyLock(key, fn, { staleSeconds });
    if (!r.busy) return r.value;
    await new Promise((resolve) => { setTimeout(resolve, waitMs); });
  }
  throw (onBusy ? onBusy() : new Error(`Could not get the lock for ${key}`));
}

module.exports = { withKeyLock, withKeyLockWait };
