// Where each kind of person signs in. On the live site every portal has its own host (partner.realtydoor.com, app.realtydoor.com),
// built from FRONTEND_URL (https://www.realtydoor.com); on a single-host site (local, test) the portals are paths on that host.
// PARTNER_PORTAL_URL / BUYER_APP_URL override it. A partner who signs in on the wrong host is told they have no access.
function portalUrl(kind, env = process.env) {
  const override = kind === 'partner' ? env.PARTNER_PORTAL_URL : env.BUYER_APP_URL;
  if (override) return String(override).replace(/\/+$/, '');
  const base = String(env.FRONTEND_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  try {
    const u = new URL(base);
    if (/^www\./.test(u.hostname)) return `${u.protocol}//${kind === 'partner' ? 'partner' : 'app'}.${u.hostname.slice(4)}`;
  } catch { /* fall through to the path form */ }
  return `${base}${kind === 'partner' ? '/partners' : '/user'}`;
}

module.exports = { portalUrl };
