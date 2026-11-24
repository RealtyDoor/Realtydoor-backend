'use strict';

// 23 Nov 2026: a burst of parallel requests (Make draining a queue of ~150 leads at once) made MongoDB answer
// "write conflict" (Prisma P2034) on rows many requests update together (the ref-code counter, an integration's lead
// count). A conflict means nothing was written, so the same write is safe to try again after a short random pause.
const isWriteConflict = (err) => err?.code === 'P2034' || /write conflict|deadlock/i.test(String(err?.message || ''));
const MAX_TRIES = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retryOnWriteConflict(fn, { pause = sleep, tries = MAX_TRIES } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isWriteConflict(err) || attempt >= tries) throw err;
      await pause(20 * attempt + Math.floor(Math.random() * 50 * attempt));
    }
  }
}

module.exports = { isWriteConflict, retryOnWriteConflict, MAX_TRIES };
