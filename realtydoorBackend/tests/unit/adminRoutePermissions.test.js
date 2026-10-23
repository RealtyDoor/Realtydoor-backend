// QA run 23 Oct: rate cards, commission overrides, builder invoices and disputing a commission were open to any admin,
// including a limited staff role. Every route below must carry its permission, and the real role presets must give
// (or withhold) it as intended. A new money-changing admin route should be added to this list.
const fs = require('fs');
const path = require('path');
const { requirePermission } = require('../../src/middleware/requirePermission');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../src/utils/adminPermissions');

const routesSource = fs.readFileSync(path.join(__dirname, '../../src/modules/admin/admin.routes.js'), 'utf8');
const moneySource = fs.readFileSync(path.join(__dirname, '../../src/modules/money/money.routes.js'), 'utf8');

const GATED = [
  ['post', '/builder-invoices', 'FINANCE'],
  ['post', '/builder-invoices/:id/collect', 'FINANCE'],
  ['post', '/builder-invoices/:id/dispute', 'FINANCE'],
  ['post', '/rate-cards', 'COMMISSION'],
  ['patch', '/rate-cards/:id', 'COMMISSION'],
  ['delete', '/rate-cards/:id', 'COMMISSION'],
  ['post', '/commission-overrides', 'COMMISSION'],
  ['delete', '/commission-overrides/:id', 'COMMISSION'],
  ['put', '/projects/:id/commission-rate', 'COMMISSION'],
  ['delete', '/projects/:id/commission-rate', 'COMMISSION'],
  ['put', '/leads/:id/commission/deal-rate', 'COMMISSION'],
  ['post', '/leads/:id/commission/lock', 'COMMISSION'],
  ['post', '/leads/:id/commission/invoice', 'FINANCE'],
  ['post', '/leads/:id/commission/collect', 'FINANCE'],
  ['post', '/leads/:id/commission/dispute', 'FINANCE'],
  ['patch', '/escrow/:id/release', 'FINANCE'],
  ['post', '/escrow/:id/refund', 'FINANCE'],
  ['post', '/escrow/:id/freeze', 'FINANCE'],
  ['post', '/escrow/:id/unfreeze', 'FINANCE'],
  ['post', '/escrow/:id/payouts/refund-remaining', 'FINANCE'],
  ['post', '/escrow/:id/repair-bookkeeping', 'FINANCE'],
];

const routeLine = (verb, p) => routesSource.split('\n').find((l) => l.replace(/\s+/g, ' ').startsWith(`router.${verb}('${p}',`));

describe('admin money routes carry their permission', () => {
  test.each(GATED)('%s %s needs %s', (verb, p, scope) => {
    const line = routeLine(verb, p);
    expect(line).toBeDefined();
    expect(line).toContain(`requirePermission('${scope}')`);
  });

  test('the whole /admin/money router is gated on FINANCE', () => {
    expect(moneySource).toContain("router.use(requirePermission('FINANCE'))");
  });
});

function verdict(scope, staffRole) {
  const user = { role: 'ADMIN', staffRole, adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE[staffRole] || [] };
  let result = 'allowed';
  requirePermission(scope)({ user }, {}, (err) => { if (err) result = err.statusCode; });
  return result;
}

describe('what each staff role can do with those permissions', () => {
  test('SUPPORT (leads, listings, KYC, tickets) cannot touch rates, invoices or release', () => {
    expect(verdict('FINANCE', 'SUPPORT')).toBe(403);
    expect(verdict('COMMISSION', 'SUPPORT')).toBe(403);
  });
  test('CONTENT_MANAGER cannot either', () => {
    expect(verdict('FINANCE', 'CONTENT_MANAGER')).toBe(403);
    expect(verdict('COMMISSION', 'CONTENT_MANAGER')).toBe(403);
  });
  test('FINANCE_STAFF has both finance and commission, and SUPER_ADMIN passes everything', () => {
    expect(verdict('FINANCE', 'FINANCE_STAFF')).toBe('allowed');
    expect(verdict('COMMISSION', 'FINANCE_STAFF')).toBe('allowed');
    expect(verdict('FINANCE', 'SUPER_ADMIN')).toBe('allowed');
    expect(verdict('COMMISSION', 'SUPER_ADMIN')).toBe('allowed');
  });
  test('an older admin with no staff role keeps full access (unchanged on purpose)', () => {
    expect(verdict('FINANCE', null)).toBe('allowed');
  });
});
