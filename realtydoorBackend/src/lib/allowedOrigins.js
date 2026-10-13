// Security fix, 2026-10-13 (B5) — the list of origins a Clerk session
// token is allowed to have been issued for (clerk.verifyToken's
// authorizedParties). Same source/parsing as app.js's own CORS
// ALLOWED_ORIGINS, kept as a single shared helper so the two don't drift
// apart — a token's `azp` claim should never be trusted from an origin
// this API wouldn't even accept a CORS request from.
function getAllowedOrigins() {
  return (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || '')
    .split(',').map((o) => o.trim()).filter(Boolean);
}

module.exports = { getAllowedOrigins };
