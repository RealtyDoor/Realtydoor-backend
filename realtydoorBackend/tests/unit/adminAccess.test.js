const { adminAccessOf, ADMIN_PERMISSION_SCOPES, DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../src/utils/adminPermissions');

describe('adminAccessOf (what the admin menu may show)', () => {
  test('is null for anyone who is not an admin, so nothing about staff leaks to buyers or partners', () => {
    expect(adminAccessOf({ role: 'USER', staffRole: 'SUPPORT', adminPermissions: ['FINANCE'] })).toBeNull();
    expect(adminAccessOf({ role: 'PARTNER' })).toBeNull();
    expect(adminAccessOf(null)).toBeNull();
  });
  test('an older admin with no staff role, and SUPER_ADMIN, have everything (the same rule requirePermission uses)', () => {
    expect(adminAccessOf({ role: 'ADMIN', staffRole: null })).toEqual({ staffRole: null, full: true, permissions: ADMIN_PERMISSION_SCOPES });
    expect(adminAccessOf({ role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: [] })).toMatchObject({ full: true, permissions: ADMIN_PERMISSION_SCOPES });
  });
  test('a staff role has exactly its permissions', () => {
    expect(adminAccessOf({ role: 'ADMIN', staffRole: 'SUPPORT', adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE.SUPPORT })).toEqual({
      staffRole: 'SUPPORT', full: false, permissions: ['LEADS', 'LISTINGS', 'KYC', 'TICKETS'],
    });
    expect(adminAccessOf({ role: 'ADMIN', staffRole: 'CONTENT_MANAGER' }).permissions).toEqual([]);
  });
  test('the returned list is a copy, not the shared constant', () => {
    const a = adminAccessOf({ role: 'ADMIN', staffRole: null });
    a.permissions.push('X');
    expect(ADMIN_PERMISSION_SCOPES).not.toContain('X');
  });
});
