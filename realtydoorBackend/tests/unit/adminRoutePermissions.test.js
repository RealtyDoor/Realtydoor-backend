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

// Staff-scoped areas, by the meaning each scope has in utils/adminPermissions.js.
const BY_SCOPE = {
  USERS: [['patch', '/users/:id/role'], ['patch', '/users/:id/suspend']],
  CONTENT: [['post', '/content'], ['patch', '/content/:id'], ['delete', '/content/:id'], ['post', '/content/upload-image'],
    ['post', '/services'], ['patch', '/services/:id'], ['delete', '/services/:id'],
    ['post', '/team'], ['patch', '/team/:id'], ['delete', '/team/:id'], ['post', '/notifications/broadcast'],
    ['post', '/wati/templates'], ['patch', '/wati/templates/:id'], ['delete', '/wati/templates/:id'],
    ['post', '/wati/templates/:id/submit'], ['patch', '/wati/templates/:id/status'], ['post', '/wati/templates/:id/test-send']],
  TICKETS: [['patch', '/tickets/:id'], ['patch', '/tickets/:id/dispatch'], ['patch', '/tickets/:id/resolve'], ['patch', '/tickets/:id/link-deal'],
    ['post', '/tickets/:id/comments'], ['post', '/tickets/:id/auto-dispatch'],
    ['post', '/vendors'], ['patch', '/vendors/:id'], ['delete', '/vendors/:id'], ['post', '/vendors/:id/availability'], ['delete', '/vendors/:id/availability/:slotId']],
  FINANCE: [['put', '/config/:key'], ['delete', '/config/:key']],
  LEADS: [['post', '/leads'], ['post', '/leads/auto-assign'], ['post', '/routing-rules'], ['patch', '/routing-rules/:id'], ['delete', '/routing-rules/:id'],
    ['patch', '/leads/:id/assign'], ['post', '/leads/:id/auto-assign'], ['patch', '/leads/:id/confirm'], ['patch', '/leads/:id/reject'], ['patch', '/leads/:id/note'],
    ['patch', '/leads/:id/otp-override'], ['patch', '/leads/:id/approve-drop'], ['patch', '/leads/:id/reject-drop']],
  LISTINGS: [['patch', '/properties/change-requests/:id/approve'], ['patch', '/properties/change-requests/:id/reject'], ['patch', '/properties/mandates/:id/revoke'],
    ['patch', '/properties/conflicts/:id/resolve'], ['post', '/properties/:id/mandates'], ['post', '/properties/:id/detect-conflicts'], ['patch', '/properties/:id/location'],
    ['patch', '/properties/checklist-documents/:docId/verify'], ['patch', '/properties/checklist-documents/:docId/reject'],
    ['post', '/properties/:id/mandates/:mandateId/owner-confirmation/request'], ['patch', '/properties/owner-confirmation/:confirmationId'],
    ['patch', '/properties/:id/approve'], ['patch', '/properties/:id/reject'], ['patch', '/properties/:id/request-changes'], ['patch', '/properties/:id'],
    ['patch', '/projects/:id/approve'], ['patch', '/projects/:id/reject'], ['patch', '/projects/:id/request-changes'], ['patch', '/projects/:id/approvals/:item']],
  KYC: [['post', '/kyc/:userId/request-documents'], ['patch', '/documents/:id/verify']],
};
for (const [scope, routes] of Object.entries(BY_SCOPE)) for (const [verb, p] of routes) GATED.push([verb, p, scope]);

const routeLine = (verb, p) => routesSource.split('\n').find((l) => l.replace(/\s+/g, ' ').startsWith(`router.${verb}('${p}',`));

describe('admin money routes carry their permission', () => {
  test.each(GATED)('%s %s needs %s', (verb, p, scope) => {
    const line = routeLine(verb, p);
    expect(line).toBeDefined();
    expect(line).toContain(`requirePermission('${scope}')`);
  });

  test('the whole /admin/money router is gated: FINANCE for everything, FINANCE_VIEW for reads only (see moneyViewOnly.test.js)', () => {
    expect(moneySource).toContain("requirePermission('FINANCE')");
    expect(moneySource).toContain("requirePermission(['FINANCE', 'FINANCE_VIEW'])");
    expect(moneySource).toMatch(/router\.use\(/);
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
  test('each staff role keeps exactly the areas its preset names', () => {
    expect(verdict('LEADS', 'SUPPORT')).toBe('allowed');
    expect(verdict('LISTINGS', 'SUPPORT')).toBe('allowed');
    expect(verdict('KYC', 'SUPPORT')).toBe('allowed');
    expect(verdict('TICKETS', 'SUPPORT')).toBe('allowed');
    expect(verdict('USERS', 'SUPPORT')).toBe(403);
    expect(verdict('CONTENT', 'SUPPORT')).toBe(403);
    expect(verdict('CONTENT', 'CONTENT_MANAGER')).toBe('allowed');
    expect(verdict('LEADS', 'CONTENT_MANAGER')).toBe(403);
    expect(verdict('LEADS', 'FINANCE_STAFF')).toBe(403);
    expect(verdict('TICKETS', 'FINANCE_STAFF')).toBe(403);
  });
  test('an older admin with no staff role keeps full access (unchanged on purpose)', () => {
    expect(verdict('FINANCE', null)).toBe('allowed');
  });
});
