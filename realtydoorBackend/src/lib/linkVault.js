'use strict';

// Saved copy of a build-out form's private link, so the team can copy or resend it later (Nov 2026, owner's request). The link's hash is still
// what the form checks; this encrypted copy exists only so an admin can read the link back. AES-256-GCM, so a changed or damaged value never
// decrypts to something wrong: it simply fails and the admin presses "New link". The key is derived (HKDF) from ONBOARDING_LINK_KEY when set,
// otherwise from OTP_HASH_SECRET, with its own label, so the secret is never used raw. Rotating the secret makes old saved links unreadable
// (copy then says to press "New link"); it never breaks a link that was already sent.
const crypto = require('crypto');

const LABEL = 'realtydoor/onboarding-link/v1';
const VERSION = 'v1';

function keyFromEnv(env = process.env) {
  const secret = env.ONBOARDING_LINK_KEY || env.OTP_HASH_SECRET;
  if (!secret || String(secret).length < 16) return null;
  return Buffer.from(crypto.hkdfSync('sha256', String(secret), 'realtydoor-link-salt', LABEL, 32));
}

const b64 = (buf) => buf.toString('base64url');

/** Returns an opaque string, or null when no usable key is configured (copy is then simply unavailable). */
function encryptToken(token, env = process.env) {
  const key = keyFromEnv(env);
  if (!key || !token) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
}

/** Returns the token, or null for anything that is missing, damaged, from another key, or of an unknown version. Never throws. */
function decryptToken(blob, env = process.env) {
  try {
    const key = keyFromEnv(env);
    if (!key || typeof blob !== 'string') return null;
    const [v, iv, tag, ct] = blob.split('.');
    if (v !== VERSION || !iv || !tag || !ct) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { encryptToken, decryptToken };
