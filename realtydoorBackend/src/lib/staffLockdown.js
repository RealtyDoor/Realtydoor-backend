'use strict';

// Limited staff lock-down, app-wide (23 Nov 2026).
//
// A BDE (SALES only) or a receptionist (RECEPTION only) is an ADMIN-role account. The /admin router already closes most of its
// routes to a sales-only BDE (middleware/salesOnly.js), but other routers let any ADMIN in: requirePartner admits ADMIN, and the
// locality CMS uses plain requireAdmin. So a limited staff account could call partner routes or edit locality data. This check runs
// inside authenticate(), so it covers every router: a limited staff member may reach only the areas its permissions need.
// Narrower rules inside an area still apply (salesOnly.js inside /admin, requirePermission on each route).

const LIMITED_SCOPES = ['SALES', 'RECEPTION'];

// Every signed-in person needs these: who am I, and my own notifications.
const COMMON = ['/api/auth', '/api/notifications'];
const BY_SCOPE = {
  SALES: ['/api/admin'],
  RECEPTION: ['/api/reception'],
};

/** True for staff whose permissions are only limited scopes (SALES and/or RECEPTION). Older admins and SUPER_ADMIN are never limited. */
function isLimitedStaff(user) {
  if (!user || user.role !== 'ADMIN' || user.staffRole == null || user.staffRole === 'SUPER_ADMIN') return false;
  const held = user.adminPermissions || [];
  return held.length > 0 && held.every((p) => LIMITED_SCOPES.includes(p));
}

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** May this user call this path at all? `path` is the full request path (no query), e.g. /api/leads/partner/x/verify-otp. */
function limitedStaffMayReach(user, path) {
  if (!isLimitedStaff(user)) return true;
  const allowed = [...COMMON, ...(user.adminPermissions || []).flatMap((p) => BY_SCOPE[p] || [])];
  return allowed.some((prefix) => under(path, prefix));
}

module.exports = { LIMITED_SCOPES, isLimitedStaff, limitedStaffMayReach };
