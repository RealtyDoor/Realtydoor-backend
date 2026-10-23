// 16.x — the permission matrix. A fixed, small set of scopes rather than a
// per-route permission string for every admin endpoint: coarse-grained on
// purpose, matching how an actual support/finance/content team is usually
// split, and easy to reason about in a directory UI.
const ADMIN_PERMISSION_SCOPES = [
  'LEADS',       // leads, auto-assign, inquiries
  'LISTINGS',    // properties, projects, mandates/conflicts
  'KYC',         // partner KYC review
  'FINANCE',     // escrow release/refund, payouts, builder invoices
  'FINANCE_VIEW', // read-only money: the deal money card, ledger, TDS and partner tax invoices (no release, refund, invoice or export)
  'COMMISSION',  // rate cards, overrides, per-lead commission terms
  'TICKETS',     // service tickets, vendors
  'USERS',       // user/partner management, role changes, suspensions
  'CONTENT',     // CMS, team roster, services catalog, FAQs
  'STAFF',       // the staff directory itself — who can grant permissions
  // Backend gaps handoff, 2026-10-10 (#3) — a user's own privacy/consent
  // audit trail (GET /admin/users/:id/privacy-events). Deliberately not
  // folded into USERS: reading someone's consent/withdrawal/deletion
  // history is a narrower, more sensitive action than general user
  // management, and isn't in any default staff-role preset below — an
  // admin/DPO needs it granted explicitly.
  'PRIVACY',
];

// A named staffRole is just a convenient preset — adminPermissions is what
// actually gets checked (SUPER_ADMIN bypasses it and always passes).
const ADMIN_STAFF_ROLES = ['SUPER_ADMIN', 'SUPPORT', 'CRM_MANAGER', 'FINANCE_STAFF', 'CONTENT_MANAGER'];

const DEFAULT_PERMISSIONS_BY_STAFF_ROLE = {
  SUPER_ADMIN: ADMIN_PERMISSION_SCOPES, // unused in practice — SUPER_ADMIN bypasses the check — kept for directory display consistency.
  SUPPORT: ['LEADS', 'LISTINGS', 'KYC', 'TICKETS'],
  // Answers buyers and partners all day, so it can SEE a deal's money (to explain a commission, TDS or payout) but cannot move any.
  CRM_MANAGER: ['LEADS', 'LISTINGS', 'KYC', 'TICKETS', 'FINANCE_VIEW'],
  FINANCE_STAFF: ['FINANCE', 'COMMISSION'],
  CONTENT_MANAGER: ['CONTENT'],
};

// What the admin app needs to show only the screens and buttons this admin may use. `full` mirrors requirePermission:
// no staff role (an older admin) or SUPER_ADMIN passes every check; otherwise only the listed permissions count.
// The server still enforces every route; this is for the menu, not for security. Null for anyone who is not an admin.
function adminAccessOf(user) {
  if (!user || user.role !== 'ADMIN') return null;
  const full = user.staffRole == null || user.staffRole === 'SUPER_ADMIN';
  return { staffRole: user.staffRole ?? null, full, permissions: full ? [...ADMIN_PERMISSION_SCOPES] : [...(user.adminPermissions || [])] };
}

module.exports = { ADMIN_PERMISSION_SCOPES, ADMIN_STAFF_ROLES, DEFAULT_PERMISSIONS_BY_STAFF_ROLE, adminAccessOf };
