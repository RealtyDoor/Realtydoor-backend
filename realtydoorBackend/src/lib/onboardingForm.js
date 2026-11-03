const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

// Build-out (onboarding) form helpers. The form's fields live in the frontend (one definition for the public form and the admin
// editor); the server only guarantees that what it stores is small, plain and safe, whatever the sender posts.

const ONBOARDING_TYPES = ['FLAT', 'INDEPENDENT_HOUSE', 'VILLA', 'PLOT', 'COMMERCIAL_OFFICE', 'RETAIL_SHOP', 'NEW_PROJECT'];
const CONTACT_ROLES = ['OWNER', 'BUILDER', 'AGENT', 'ADVISOR'];
const STATUSES = ['SENT', 'RECEIVED', 'IN_DISCUSSION', 'READY', 'CONVERTED', 'CLOSED'];
// The sender may keep editing only while the team has not taken over.
const SENDER_EDITABLE = ['SENT', 'RECEIVED'];

const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 60;
const MAX_DOCUMENTS = 80;
const MAX_PER_DOC_KEY = 30;
const MAX_ANSWER_BYTES = 120 * 1024;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const DOC_KEY_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const looksLikeToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(t);

const bad = () => new ApiError(400, 'Some answers could not be saved. Please check the form and try again.', { code: 'BAD_ANSWERS' });

function cleanPrimitive(v) {
  if (typeof v === 'string') {
    const t = v.replace(/\u0000/g, '').trim();
    if (t.length > 3000) throw bad();
    return t === '' ? undefined : t;
  }
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw bad(); return v; }
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return undefined;
  throw bad();
}

/**
 * Turns posted answers into a plain object the server is happy to keep: keys are plain words, values are text, numbers, yes/no, a list
 * of short text (multiple choice) or a list of rows (the project's unit types), and the whole thing is small. Empty answers are dropped.
 */
function sanitizeAnswers(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw bad();
  const out = {};
  const entries = Object.entries(input);
  if (entries.length > 300) throw bad();
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) throw bad();
    if (Array.isArray(v)) {
      if (v.length > 60) throw bad();
      if (v.every((x) => typeof x === 'string')) {
        const list = v.map((x) => x.replace(/\u0000/g, '').trim()).filter(Boolean);
        if (list.some((x) => x.length > 200)) throw bad();
        if (list.length) out[k] = list;
      } else {
        const rows = [];
        for (const row of v) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad();
          const entriesInRow = Object.entries(row);
          if (entriesInRow.length > 25) throw bad();
          const r = {};
          for (const [rk, rv] of entriesInRow) {
            if (!KEY_RE.test(rk)) throw bad();
            const c = cleanPrimitive(rv);
            if (c !== undefined) r[rk] = c;
          }
          if (Object.keys(r).length) rows.push(r);
        }
        if (rows.length) out[k] = rows;
      }
      continue;
    }
    const c = cleanPrimitive(v);
    if (c !== undefined) out[k] = c;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_ANSWER_BYTES) throw new ApiError(400, 'That is too much text for one form.', { code: 'BAD_ANSWERS' });
  return out;
}

function cleanDocKey(key) {
  if (typeof key !== 'string' || !DOC_KEY_RE.test(key)) throw new ApiError(400, 'Unknown document type.');
  return key;
}

/**
 * Can the person holding the link use it right now? 'ok' means yes. Anything else is why not. `editable` is whether they may still
 * change things (the team locks it once it is in discussion).
 */
function linkState(row, now = new Date()) {
  if (!row) return { state: 'missing', editable: false };
  if (row.revokedAt) return { state: 'revoked', editable: false };
  if (row.expiresAt && new Date(row.expiresAt) <= now) return { state: 'expired', editable: false };
  return { state: 'ok', editable: SENDER_EDITABLE.includes(row.status) };
}

const expiryFromDays = (days, now = new Date()) => {
  const d = Number.isFinite(Number(days)) ? Math.min(Math.max(Math.floor(Number(days)), 1), MAX_EXPIRY_DAYS) : DEFAULT_EXPIRY_DAYS;
  return new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
};

/** What the person with the link may see of a stored document: never the bucket link. */
const publicDocument = (d) => ({ id: d.id, key: d.key, name: d.name, size: d.size, uploadedAt: d.uploadedAt });

module.exports = {
  ONBOARDING_TYPES, CONTACT_ROLES, STATUSES, SENDER_EDITABLE,
  DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, MAX_DOCUMENTS, MAX_PER_DOC_KEY,
  newToken, hashToken, looksLikeToken, sanitizeAnswers, cleanDocKey, linkState, expiryFromDays, publicDocument,
};
