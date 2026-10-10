// Privacy spec, 2026-10-10 — single rule consulted by every email, WhatsApp,
// push and in-app sender, so the Settings screen's toggles actually do
// something. Three tiers:
//   TRANSACTIONAL — receipts, OTPs, security/legal notices. Always sent,
//     regardless of any toggle (the spec's explicit carve-out).
//   MARKETING     — requires the consolidated marketingOptIn to be true.
//   OPERATIONAL   — default. Respects the per-channel toggle
//     (notifEmail/notifWhatsapp/notifPush).
//
// `user` is whatever the caller already has in scope (full User row, or a
// select with just the relevant boolean fields). Many senders target a
// free-text lead's buyerEmail/buyerPhone, which has no User row at all —
// there is no account to check preferences against, so canSend fails open
// (same behaviour as before this gate existed) rather than guessing.
const CATEGORIES = { TRANSACTIONAL: 'TRANSACTIONAL', OPERATIONAL: 'OPERATIONAL', MARKETING: 'MARKETING' };

const CHANNEL_FIELD = { EMAIL: 'notifEmail', WHATSAPP: 'notifWhatsapp', PUSH: 'notifPush' };

function canSend({ user, channel, category = CATEGORIES.OPERATIONAL }) {
  if (category === CATEGORIES.TRANSACTIONAL) return true;
  if (!user) return true;
  if (category === CATEGORIES.MARKETING) return user.marketingOptIn === true;
  const field = CHANNEL_FIELD[channel];
  return field ? user[field] !== false : true;
}

module.exports = { canSend, CATEGORIES };
