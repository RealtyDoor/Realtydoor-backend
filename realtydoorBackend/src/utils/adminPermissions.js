// 16.x — the permission matrix. A fixed, small set of scopes rather than a
// per-route permission string for every admin endpoint: coarse-grained on
// purpose, matching how an actual support/finance/content team is usually
// split, and easy to reason about in a directory UI.
const ADMIN_PERMISSION_SCOPES = [
  'LEADS',       // leads, auto-assign, inquiries
  'LISTINGS',    // properties, projects, mandates/conflicts
  'KYC',         // partner KYC review
  'FINANCE',     // escrow release/refund, payouts, builder invoices
  'COMMISSION',  // rate cards, overrides, per-lead commission terms
  'TICKETS',     // service tickets, vendors
  'USERS',       // user/partner management, role changes, suspensions
  'CONTENT',     // CMS, team roster, services catalog, FAQs
  'STAFF',       // the staff directory itself — who can grant permissions
];

// A named staffRole is just a convenient preset — adminPermissions is what
// actually gets checked (SUPER_ADMIN bypasses it and always passes).
const ADMIN_STAFF_ROLES = ['SUPER_ADMIN', 'SUPPORT', 'FINANCE_STAFF', 'CONTENT_MANAGER'];

const DEFAULT_PERMISSIONS_BY_STAFF_ROLE = {
  SUPER_ADMIN: ADMIN_PERMISSION_SCOPES, // unused in practice — SUPER_ADMIN bypasses the check — kept for directory display consistency.
  SUPPORT: ['LEADS', 'LISTINGS', 'KYC', 'TICKETS'],
  FINANCE_STAFF: ['FINANCE', 'COMMISSION'],
  CONTENT_MANAGER: ['CONTENT'],
};

module.exports = { ADMIN_PERMISSION_SCOPES, ADMIN_STAFF_ROLES, DEFAULT_PERMISSIONS_BY_STAFF_ROLE };
