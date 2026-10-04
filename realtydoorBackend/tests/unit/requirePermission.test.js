const { requirePermission } = require('../../src/middleware/requirePermission');

// No Express app involved — a middleware is just (req, res, next), and next
// is how we observe the verdict (called with no args = allowed, called with
// an error = denied). No database needed either: every check is pure
// property access on req.user.
function run(scope, user) {
  const req = { user };
  const res = {};
  let result = null;
  // Express's own convention: next() with no args means "allowed, move on".
  // Normalized to null here so every "allowed" assertion below can just
  // read toBeNull() instead of every call site caring whether next() was
  // invoked with undefined vs not invoked with an error at all.
  const next = (err) => { result = err ?? null; };
  requirePermission(scope)(req, res, next);
  return result;
}

describe('requirePermission', () => {
  test('401s when there is no authenticated user at all', () => {
    const err = run('FINANCE', null);
    expect(err.statusCode).toBe(401);
  });

  test('403s a non-ADMIN role outright, regardless of permissions', () => {
    const err = run('FINANCE', { role: 'PARTNER', staffRole: null, adminPermissions: [] });
    expect(err.statusCode).toBe(403);
  });

  // The whole backward-compatibility guarantee this feature was built
  // around: every admin that existed before staffRole shipped must keep
  // full access, unconditionally, on every scope.
  test('a legacy admin (staffRole never set) passes every scope', () => {
    ['FINANCE', 'STAFF', 'TICKETS', 'KYC', 'COMMISSION', 'USERS', 'CONTENT', 'LEADS', 'LISTINGS'].forEach((scope) => {
      const err = run(scope, { role: 'ADMIN', staffRole: null, adminPermissions: [] });
      expect(err).toBeNull();
    });
  });

  test('a legacy admin passes even if adminPermissions is undefined entirely', () => {
    const err = run('FINANCE', { role: 'ADMIN', staffRole: null });
    expect(err).toBeNull();
  });

  test('SUPER_ADMIN bypasses the check even with an empty permissions array', () => {
    const err = run('STAFF', { role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: [] });
    expect(err).toBeNull();
  });

  test('a scoped staff member is allowed on a granted permission', () => {
    const err = run('TICKETS', { role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: ['LEADS', 'TICKETS'] });
    expect(err).toBeNull();
  });

  test('a scoped staff member is denied a permission they were not granted', () => {
    const err = run('FINANCE', { role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: ['LEADS', 'TICKETS'] });
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/Missing the FINANCE permission/);
  });

  test('a scoped staff member with no permissions granted at all is denied everything', () => {
    const err = run('LEADS', { role: 'ADMIN', staffRole: 'CONTENT_MANAGER', adminPermissions: [] });
    expect(err.statusCode).toBe(403);
  });
});
