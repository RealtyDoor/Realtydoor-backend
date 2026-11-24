// 23 Nov 2026: limited staff (sales-only BDE, receptionist) are ADMIN-role accounts. Outside /admin, requirePartner admits ADMIN and the
// locality CMS uses plain requireAdmin, so they reached partner and locality routes. The lock now runs in authenticate() for every router.
const { isLimitedStaff, limitedStaffMayReach } = require('../../src/lib/staffLockdown');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE, ADMIN_STAFF_ROLES, ADMIN_PERMISSION_SCOPES } = require('../../src/utils/adminPermissions');

const admin = (over) => ({ role: 'ADMIN', staffRole: null, adminPermissions: [], ...over });
const BDE = admin({ staffRole: 'BDE', adminPermissions: ['SALES'] });
const RECEPTION = admin({ staffRole: 'RECEPTION', adminPermissions: ['RECEPTION'] });
const BOTH = admin({ staffRole: 'BDE', adminPermissions: ['SALES', 'RECEPTION'] });

describe('isLimitedStaff', () => {
  test.each([
    ['older admin with no staff role', admin(), false],
    ['super admin', admin({ staffRole: 'SUPER_ADMIN', adminPermissions: ['RECEPTION'] }), false],
    ['support', admin({ staffRole: 'SUPPORT', adminPermissions: ['LEADS', 'KYC'] }), false],
    ['sales plus leads', admin({ staffRole: 'BDE', adminPermissions: ['SALES', 'LEADS'] }), false],
    ['staff with no permissions', admin({ staffRole: 'BDE', adminPermissions: [] }), false],
    ['partner', { role: 'PARTNER', staffRole: 'RECEPTION', adminPermissions: ['RECEPTION'] }, false],
    ['BDE', BDE, true],
    ['receptionist', RECEPTION, true],
    ['sales and reception', BOTH, true],
  ])('%s', (_name, user, expected) => expect(isLimitedStaff(user)).toBe(expected));
});

describe('limitedStaffMayReach', () => {
  const blockedForAll = [
    '/api/leads/partner/6afca91c6717f382bd10fc4c/verify-otp',
    '/api/partner/dashboard',
    '/api/locality-insights/6afca91c6717f382bd10fc4c',
    '/api/escrow/orders',
    '/api/user/profile',
    '/api/properties/partner/mine',
    '/api/admin-tools', // a prefix that only looks like /api/admin
    '/api/receptionist',
  ];

  test.each(blockedForAll)('BDE blocked from %s', (p) => expect(limitedStaffMayReach(BDE, p)).toBe(false));
  test.each(blockedForAll)('receptionist blocked from %s', (p) => expect(limitedStaffMayReach(RECEPTION, p)).toBe(false));

  test('BDE keeps /admin (narrowed further by salesOnly.js), auth and notifications', () => {
    for (const p of ['/api/admin/leads', '/api/admin', '/api/auth/me', '/api/notifications/unread-count']) expect(limitedStaffMayReach(BDE, p)).toBe(true);
    expect(limitedStaffMayReach(BDE, '/api/reception/visits')).toBe(false);
  });

  test('receptionist reaches only reception, auth and notifications', () => {
    for (const p of ['/api/reception', '/api/reception/visits', '/api/auth/me', '/api/notifications']) expect(limitedStaffMayReach(RECEPTION, p)).toBe(true);
    for (const p of ['/api/admin/leads', '/api/admin/reception-visits', '/api/admin/staff']) expect(limitedStaffMayReach(RECEPTION, p)).toBe(false);
  });

  test('sales plus reception gets both areas', () => {
    expect(limitedStaffMayReach(BOTH, '/api/admin/leads')).toBe(true);
    expect(limitedStaffMayReach(BOTH, '/api/reception/visits')).toBe(true);
    expect(limitedStaffMayReach(BOTH, '/api/partner/dashboard')).toBe(false);
  });

  test('everyone else is untouched', () => {
    for (const u of [admin(), admin({ staffRole: 'SUPPORT', adminPermissions: ['LEADS'] }), { role: 'PARTNER' }, { role: 'USER' }]) {
      expect(limitedStaffMayReach(u, '/api/partner/dashboard')).toBe(true);
    }
  });
});

describe('Receptionist role', () => {
  test('is a staff role whose preset is only RECEPTION', () => {
    expect(ADMIN_PERMISSION_SCOPES).toContain('RECEPTION');
    expect(ADMIN_STAFF_ROLES).toContain('RECEPTION');
    expect(DEFAULT_PERMISSIONS_BY_STAFF_ROLE.RECEPTION).toEqual(['RECEPTION']);
    expect(isLimitedStaff(admin({ staffRole: 'RECEPTION', adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE.RECEPTION }))).toBe(true);
  });
});
