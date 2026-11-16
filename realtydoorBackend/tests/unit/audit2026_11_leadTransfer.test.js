// Go-live prep: moving the real leads to production (src/lib/leadTransfer.js, scripts/exportRealLeads.js, scripts/importRealLeads.js).
const fs = require('fs');
const path = require('path');
const lt = require('../../src/lib/leadTransfer');
const script = (p) => fs.readFileSync(path.join(__dirname, '../../scripts', p), 'utf8');

const fb = (over = {}) => ({
  id: 'l1', refCode: 'RD-L-000112', buyerName: 'Venkat Reddy', buyerEmail: 'venkat@gmail.com', buyerPhone: '+919800000001', source: 'FACEBOOK', status: 'UNASSIGNED',
  propertyId: 'p1', intakeIntegrationId: 'i1', buyerId: null, assignedPartnerId: null, ownerStaffId: null, updatedAt: new Date(), createdAt: new Date('2026-10-01T10:00:00.000Z'),
  intakeAnswers: { source: 'facebook', lead_id: '1450585770536619' }, ...over,
});

describe('which leads are real', () => {
  const ctx = { hasEscrow: false, propertyTitle: 'Vrunda City Gated Plots' };
  test('an unlinked Facebook lead for a real listing is real', () => {
    expect(lt.whyNotReal(fb(), ctx)).toBeNull();
  });
  test.each([
    [{ source: 'PARTNER' }, {}, /source/],
    [{}, { hasEscrow: true }, /escrow/],
    [{ buyerId: 'u1' }, {}, /buyerId/],
    [{ assignedPartnerId: 'p9' }, {}, /assignedPartnerId/],
    [{ ownerStaffId: 's1' }, {}, /ownerStaffId/],
    [{ propertyId: null }, {}, /no listing/],
    [{ buyerName: 'Mock QA Buyer' }, {}, /test-looking/],
    [{ buyerEmail: 'a@mockqa.test' }, {}, /test-looking/],
    [{}, { propertyTitle: 'Beta E2E Test 2BHK' }, /test listing/],
  ])('%j with %j is left out', (over, c, why) => {
    expect(lt.whyNotReal(fb(over), { ...ctx, ...c })).toMatch(why);
  });
  test('every id column of Lead is covered, so a new link cannot slip through', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema/lead.prisma'), 'utf8');
    const body = schema.slice(schema.indexOf('model Lead {'), schema.indexOf('\n}\n', schema.indexOf('model Lead {')));
    const idCols = [...body.matchAll(/^\s+(\w+)\s+String\??\s+@db\.ObjectId/gm)].map((m) => m[1]).filter((n) => n !== 'id');
    const known = new Set([...lt.LINK_FIELDS, 'propertyId', 'intakeIntegrationId']);
    expect(idCols.filter((c) => !known.has(c))).toEqual([]);
  });
});

describe('record and back', () => {
  test('the record carries the listing slug and no ids', () => {
    const r = lt.toRecord(fb(), 'vrunda-city');
    expect(r.propertySlug).toBe('vrunda-city');
    for (const k of ['id', 'propertyId', 'intakeIntegrationId', 'updatedAt', 'buyerId', 'assignedPartnerId']) expect(k in r).toBe(false);
    expect(r.refCode).toBe('RD-L-000112');
  });
  test('after a JSON round trip, dates are dates again and the new listing id is set', () => {
    const r = JSON.parse(JSON.stringify(lt.toRecord(fb(), 'vrunda-city')));
    const data = lt.fromRecord(r, 'NEWID');
    expect(data.propertyId).toBe('NEWID');
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.createdAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect('propertySlug' in data).toBe(false);
    expect(data.buyerName).toBe('Venkat Reddy');
  });
});

describe('the import plan', () => {
  const rec = (n, over = {}) => lt.toRecord(fb({ refCode: `RD-L-${String(n).padStart(6, '0')}`, intakeAnswers: { lead_id: `m${n}` }, ...over }), 'vrunda-city');
  const listingsBySlug = new Map([['vrunda-city', { id: 'P1', slug: 'vrunda-city' }]]);
  test('adds what is new and takes the listing id from the target', () => {
    const p = lt.planImport([rec(112), rec(114)], { listingsBySlug });
    expect(p.toCreate).toHaveLength(2);
    expect(p.toCreate[0].data.propertyId).toBe('P1');
    expect(p.maxRef).toBe(114);
  });
  test('running it twice adds nothing the second time (ref code or Meta lead id already there)', () => {
    const p = lt.planImport([rec(112), rec(114, { refCode: 'RD-L-000999' })], { listingsBySlug, existingRefCodes: new Set(['RD-L-000112']), existingMetaIds: new Set(['m114']) });
    expect(p.toCreate).toHaveLength(0);
    expect(p.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/ref code/), expect.stringMatching(/Meta lead id/)]);
  });
  test('a repeat inside the file is added once', () => {
    expect(lt.planImport([rec(112), rec(112)], { listingsBySlug }).toCreate).toHaveLength(1);
  });
  test('a lead whose listing is not in the target is skipped and named', () => {
    const p = lt.planImport([rec(112)], { listingsBySlug: new Map() });
    expect(p.toCreate).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/vrunda-city.*not in the target/);
  });
  test('junk records are skipped, not crashed on', () => {
    const p = lt.planImport([null, {}, { buyerPhone: '1' }], { listingsBySlug });
    expect(p.toCreate).toHaveLength(0);
    expect(p.skipped).toHaveLength(3);
  });
  test('ref code numbers', () => {
    expect(lt.refNumber('RD-L-000164')).toBe(164);
    expect(lt.refNumber('x')).toBe(0);
  });
});

describe('the scripts are fenced', () => {
  test('the import can only aim at TARGET_DATABASE_URL, needs --apply and the exact host, and raises the counter', () => {
    const s = script('importRealLeads.js');
    expect(s).toMatch(/process\.env\.TARGET_DATABASE_URL/);
    expect(s).not.toMatch(/process\.env\.DATABASE_URL/);
    expect(s).toMatch(/--confirm-host/);
    expect(s).toMatch(/if \(!APPLY\)[\s\S]*return/);
    expect(s).toMatch(/counter\.upsert/);
  });
  test('the export only reads and writes a private file inside a git-ignored folder', () => {
    const s = script('exportRealLeads.js');
    expect(s).not.toMatch(/\.(create|update|delete|upsert)(Many)?\(/);
    expect(s).toMatch(/mode: 0o600/);
    expect(fs.readFileSync(path.join(__dirname, '../../.gitignore'), 'utf8')).toMatch(/^exports\/$/m);
  });
});
