// 7 Nov 2026: 93 of 242 /admin routes had no permission gate, so a limited staff role (a content manager, finance staff) could read the
// user list, KYC documents, escrow and audit logs, and change loans, disputes and reviews. Now EVERY route in admin.routes.js must carry
// requirePermission, with the scopes below. Owners, SUPER_ADMIN and admins with no staff role still pass everything (requirePermission).
// Adding an admin route without a gate fails this file; add the route to a rule here (or give it its own requirePermission) on purpose.
const fs = require('fs');
const path = require('path');
const { requirePermission } = require('../../src/middleware/requirePermission');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../src/utils/adminPermissions');

const source = fs.readFileSync(path.join(__dirname, '../../src/modules/admin/admin.routes.js'), 'utf8');
const routes = source.split('\n')
  .map((line) => /^router\.(get|post|put|patch|delete)\('([^']+)'/.exec(line) && { line, verb: RegExp.$1, path: RegExp.$2 })
  .filter(Boolean);

// The scopes a route that had no gate must now carry (any one is enough), by path. First match wins.
const RULES = [
  [(v, p) => v === 'get' && /^\/leads\/:id\/commission/.test(p), ['LEADS', 'COMMISSION', 'FINANCE', 'FINANCE_VIEW']],
  [(v, p) => v === 'get' && (p === '/leads' || p === '/leads/:id'), ['LEADS', 'SALES']],
  [(v, p) => p === '/routing-rules', 'LEADS'],
  [(v, p) => v === 'get' && p === '/projects/:id/commission-rate', ['LISTINGS', 'COMMISSION']],
  [(v, p) => /^\/(properties|projects|microsites)/.test(p), 'LISTINGS'],
  [(v, p) => /^\/builder-invoices/.test(p), ['FINANCE', 'FINANCE_VIEW']],
  [(v, p) => /^\/(kyc|documents)/.test(p), 'KYC'],
  [(v, p) => v === 'get' && /^\/escrow/.test(p), ['FINANCE', 'FINANCE_VIEW']],
  [(v, p) => /^\/(revenue|payout-accounts|loan|config)/.test(p), 'FINANCE'],
  [(v, p) => /^\/(rate-cards|commission-overrides|project-rates)/.test(p), ['COMMISSION', 'FINANCE_VIEW']],
  [(v, p) => /^\/analytics\/(revenue|escrow-float)/.test(p), ['FINANCE', 'FINANCE_VIEW']],
  [(v, p) => /^\/analytics/.test(p), ['LEADS', 'USERS', 'FINANCE', 'FINANCE_VIEW']],
  [(v, p) => /^\/audit-logs/.test(p), 'STAFF'],
  [(v, p) => /^\/users/.test(p), ['USERS', 'LEADS', 'TICKETS', 'KYC']],
  [(v, p) => /^\/partners/.test(p), ['USERS', 'LEADS', 'TICKETS', 'KYC', 'FINANCE_VIEW', 'COMMISSION']],
  [(v, p) => /^\/(b2b|advisor-referrals)/.test(p), 'USERS'],
  [(v, p) => /^\/(tickets|vendors|ratings|reviews|partner-support-tickets)/.test(p), 'TICKETS'],
  [(v, p) => /^\/contact/.test(p), ['LEADS', 'TICKETS']],
  [(v, p) => /^\/(nri-leads|video-tours)/.test(p), 'LEADS'],
  [(v, p) => /^\/disputes/.test(p), ['TICKETS', 'FINANCE', 'FINANCE_VIEW']],
  [(v, p) => /^\/wati/.test(p), ['LEADS', 'CONTENT']],
  [(v, p) => /^\/(content|services|team)/.test(p), 'CONTENT'],
];
const expectedFor = (verb, p) => { const hit = RULES.find(([m]) => m(verb, p)); return hit && hit[1]; };
const gateText = (scope) => (Array.isArray(scope) ? `requirePermission([${scope.map((s) => `'${s}'`).join(', ')}])` : `requirePermission('${scope}')`);

describe('every /admin route has a permission gate', () => {
  test('the router has the routes we expect to read (guards against a broken parser)', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  test.each(routes.map((r) => [r.verb, r.path, r.line]))('%s %s carries requirePermission', (verb, p, line) => {
    expect(line).toContain('requirePermission(');
  });

  test('the gated-by-rule routes carry exactly the scopes in RULES (a line that already had its own gate is left as it was)', () => {
    const wrong = routes.filter((r) => expectedFor(r.verb, r.path) && !r.line.includes(gateText(expectedFor(r.verb, r.path))))
      .filter((r) => !/requirePermission\('(LEADS|LISTINGS|FINANCE|COMMISSION|KYC|STAFF|TICKETS|CONTENT|USERS|PRIVACY)'\)/.test(r.line));
    expect(wrong.map((r) => `${r.verb} ${r.path}`)).toEqual([]);
  });
});

function verdict(scope, staffRole) {
  const user = { role: 'ADMIN', staffRole, adminPermissions: DEFAULT_PERMISSIONS_BY_STAFF_ROLE[staffRole] || [] };
  let result = 'allowed';
  requirePermission(scope)({ user }, {}, (err) => { if (err) result = err.statusCode; });
  return result;
}
const canRead = (verb, p, role) => verdict(expectedFor(verb, p), role);

describe('what each limited role can now reach (the cases the QA pass worried about)', () => {
  test('a content manager no longer reads users, KYC, escrow, revenue, audit logs or loans, and cannot touch loans, disputes or reviews', () => {
    for (const [verb, p] of [['get', '/users'], ['get', '/users/:id'], ['get', '/kyc'], ['get', '/kyc/:userId'], ['get', '/escrow'], ['get', '/revenue'], ['get', '/audit-logs'],
      ['get', '/loan'], ['patch', '/loan/:id/status'], ['patch', '/disputes/:id'], ['patch', '/reviews/:id/moderate'], ['get', '/partners']]) {
      expect([verb, p, canRead(verb, p, 'CONTENT_MANAGER')]).toEqual([verb, p, 403]);
    }
  });
  test('a content manager still reaches the content, services and team lists', () => {
    for (const p of ['/content', '/content/:id', '/services', '/team']) expect(canRead('get', p, 'CONTENT_MANAGER')).toBe('allowed');
  });
  test('finance staff reach money reads and loans but not tickets, contact messages or users', () => {
    for (const [verb, p] of [['get', '/escrow'], ['get', '/revenue'], ['get', '/loan'], ['patch', '/loan/:id/status'], ['get', '/builder-invoices'], ['get', '/payout-accounts'], ['get', '/config']]) {
      expect([p, canRead(verb, p, 'FINANCE_STAFF')]).toEqual([p, 'allowed']);
    }
    for (const [verb, p] of [['get', '/tickets'], ['get', '/contact'], ['get', '/users'], ['get', '/kyc'], ['get', '/audit-logs'], ['get', '/properties']]) {
      expect([p, canRead(verb, p, 'FINANCE_STAFF')]).toEqual([p, 403]);
    }
  });
  test('support and CRM keep leads, listings, KYC, tickets and users; only CRM sees the money reads; neither reads audit logs, config or revenue', () => {
    for (const role of ['SUPPORT', 'CRM_MANAGER']) {
      for (const [verb, p] of [['get', '/leads'], ['get', '/leads/:id'], ['get', '/properties'], ['get', '/kyc'], ['get', '/tickets'], ['get', '/contact'], ['get', '/users'], ['get', '/partners'], ['get', '/video-tours'], ['patch', '/disputes/:id']]) {
        expect([role, p, canRead(verb, p, role)]).toEqual([role, p, 'allowed']);
      }
      for (const [verb, p] of [['get', '/audit-logs'], ['get', '/revenue'], ['get', '/config'], ['get', '/loan']]) expect([role, p, canRead(verb, p, role)]).toEqual([role, p, 403]);
    }
    expect(canRead('get', '/escrow', 'CRM_MANAGER')).toBe('allowed');
    expect(canRead('get', '/escrow', 'SUPPORT')).toBe(403);
  });
  test('a BDE (SALES only) reaches only the two lead reads here; salesOnly.js closes the rest', () => {
    expect(canRead('get', '/leads', 'BDE')).toBe('allowed');
    expect(canRead('get', '/leads/:id', 'BDE')).toBe('allowed');
    expect(canRead('get', '/leads/:id/commission', 'BDE')).toBe(403);
    expect(canRead('get', '/users', 'BDE')).toBe(403);
  });
  test('owners, SUPER_ADMIN and an admin with no staff role pass every gate', () => {
    for (const r of routes) {
      const scope = expectedFor(r.verb, r.path);
      if (!scope) continue;
      expect(verdict(scope, 'SUPER_ADMIN')).toBe('allowed');
      expect(verdict(scope, null)).toBe('allowed');
    }
  });
});
