// The qualification pool (lib/poolLeads.js) must stay out of every live flow. This test reads the source: any lookup of a lead BY PHONE must
// either leave pool leads out (LIVE_LEADS / onlyLive / inPool on the same statement) or be listed here with the reason it may see them.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

// "file :: first words of the statement" -> why a pool lead may be seen there
const ALLOWED = {
  'lib/doNotContact.js': 'a do-not-contact mark applies to the number whichever lead holds it',
  'lib/bulkLeads.js': 'the importer itself builds pool leads',
  'lib/leadListFilter.js': 'staff search box on lists that already filter the pool in or out',
  'modules/referrals/': 'referral table, not leads',
  'modules/commission/commission.service.js': 'reads a known lead id',
  'modules/leads/leads.service.js': 'ownership (a pool lead counts as the platform knowing the buyer first, owner decision 24 Nov) and related-lead links',
  'modules/reception/reception.service.js': 'reception works on OPEN visit leads and a staff search; pool leads have no site visit',
  'modules/admin/admin.service.js': 'staff-side related-lead and merge lookups; a manager must see pool copies',
  'modules/leadIntake/leadIntake.service.js': 'ownership and "earlier" link are meant to see the pool copy (linked via relatedLeadId)',
  'jobs/leadHygiene.js': 'looks up a USER account by phone, not a lead',
  'modules/admin/leadCalling.service.js': 'the do-not-contact mark covers every lead with that number, in or out of the pool',
  'modules/users/users.service.js': 'the claim lookups carry LIVE_LEADS in an AND list',
  'modules/wati/whatsappInbox.service.js': 'name search in the staff inbox only',
};

test('every lead lookup by phone leaves out the pool, or is on the reviewed list', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    if (Object.keys(ALLOWED).some((k) => rel === k || rel.startsWith(k))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/prisma\.lead\.(findFirst|findMany|findUnique|count|updateMany)\(/.test(line)) return;
      const stmt = lines.slice(i, i + 4).join(' ');
      if (!/buyerPhone/.test(stmt)) return;
      if (!/LIVE_LEADS|onlyLive|inPool/.test(stmt)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

test('a pool lead can never be linked to a buyer account', () => {
  const { canLinkLeadToUser } = require('../../src/lib/leadClaim');
  const user = { role: 'USER', phone: '+919876543210', phoneVerified: true };
  const lead = { buyerPhone: '+919876543210', status: 'UNASSIGNED' };
  expect(canLinkLeadToUser(lead, user)).toBe(true);
  expect(canLinkLeadToUser({ ...lead, poolBatch: 'buildesk-2026-11' }, user)).toBe(false);
  expect(canLinkLeadToUser({ ...lead, poolBatch: 'buildesk-2026-11', poolReleasedAt: new Date() }, user)).toBe(true);
});

test('the pool batch for a "qualify first" source is its name and the India month', () => {
  const { intakeBatch } = require('../../src/lib/poolLeads');
  expect(intakeBatch('Meta lead forms (via Make)', new Date('2026-11-24T06:00:00Z'))).toBe('meta-lead-forms-via-make-2026-11');
  expect(intakeBatch('Website', new Date('2026-11-30T20:00:00Z'))).toBe('website-2026-12'); // 1 Dec in India already
  expect(intakeBatch('', new Date('2026-01-05T06:00:00Z'))).toBe('source-2026-01');
});
