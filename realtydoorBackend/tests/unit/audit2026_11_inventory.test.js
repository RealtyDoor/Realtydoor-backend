// Inventory management: units of builder projects (admin list, status, bulk, export, import, listing figures) and the availability of
// single listings (available, on hold, sold, rented).
jest.mock('../../src/lib/prisma', () => {
  const models = {};
  return new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || model === '__esModule' || model === 'then') return undefined;
      if (model.startsWith('$')) { models[model] = models[model] || jest.fn(); return models[model]; }
      models[model] = models[model] || new Proxy({}, { get(m, fn) { if (typeof fn !== 'string') return undefined; m[fn] = m[fn] || jest.fn(); return m[fn]; } });
      return models[model];
    },
  });
});
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn(), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/cache', () => ({ withCache: jest.fn((k, t, fn) => fn()), cacheDel: jest.fn(), cacheDelPattern: jest.fn() }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/lib/prisma');
const notifications = require('../../src/lib/notifications');
const audit = require('../../src/lib/auditLog');
const inv = require('../../src/modules/projects/inventory.service');
const avail = require('../../src/modules/properties/availability.service');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

beforeEach(() => {
  jest.resetAllMocks();
  notifications.notifyAdmins.mockResolvedValue({});
  audit.createAuditLog.mockResolvedValue({});
});

describe('the list and its filters', () => {
  test('filters become a where', () => {
    const w = inv.unitWhere({ projectId: 'p1', status: 'SOLD', unitType: 'FLAT', bhk: '3', minPrice: '100', maxPrice: '900', q: 'A-1', builderId: 'b1', city: 'Bengaluru', projectStatus: 'APPROVED' });
    expect(w).toMatchObject({ projectId: 'p1', status: 'SOLD', unitType: 'FLAT', bhk: 3, price: { gte: 100, lte: 900 }, project: { is: { builderId: 'b1', publishStatus: 'APPROVED' } } });
    expect(w.unitNumber.contains).toBe('A-1');
  });
  test('junk is ignored, not passed on', () => {
    const w = inv.unitWhere({ status: 'HACKED', bhk: 'x', minPrice: 'abc', q: 'x'.repeat(500) });
    expect(w.status).toBeUndefined();
    expect(w.bhk).toBeUndefined();
    expect(w.price).toBeUndefined();
    expect(w.unitNumber.contains.length).toBe(50);
  });
  test('the list names the builder of each unit', async () => {
    prisma.projectUnit.findMany.mockResolvedValue([{ id: 'u1', project: { builderId: 'b1', title: 'P' } }]);
    prisma.projectUnit.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([{ id: 'b1', name: 'B', companyName: 'B Homes' }]);
    const r = await inv.listUnits({}, 0, 50);
    expect(r.total).toBe(1);
    expect(r.data[0].builder.companyName).toBe('B Homes');
  });
  test('the summary counts all four statuses and ignores the status filter', async () => {
    prisma.projectUnit.count.mockResolvedValue(2);
    prisma.projectUnit.aggregate.mockResolvedValue({ _sum: { price: 5000000 } });
    const s = await inv.summary({ status: 'SOLD', projectId: 'p1' });
    expect(Object.keys(s.byStatus).sort()).toEqual(['AVAILABLE', 'BOOKED', 'ON_HOLD', 'SOLD']);
    expect(s.total).toBe(8);
    expect(prisma.projectUnit.count.mock.calls.every((c) => c[0].where.projectId === 'p1')).toBe(true);
  });
});

describe('admin status change', () => {
  const unit = { id: 'u1', projectId: 'p1', unitNumber: 'A-1', status: 'AVAILABLE' };
  test('a missing unit is a 404; the same status changes nothing', async () => {
    prisma.projectUnit.findUnique.mockResolvedValueOnce(null);
    await expect(inv.setStatus('u1', { status: 'SOLD', reason: 'because' }, 'ad', null)).rejects.toMatchObject({ statusCode: 404 });
    prisma.projectUnit.findUnique.mockResolvedValueOnce(unit);
    await inv.setStatus('u1', { status: 'AVAILABLE', reason: 'because' }, 'ad', null);
    expect(prisma.projectUnit.updateMany).not.toHaveBeenCalled();
  });
  test('a change is conditional, audited with the reason, and syncs the listing figures', async () => {
    prisma.projectUnit.findUnique.mockResolvedValue(unit);
    prisma.projectUnit.updateMany.mockResolvedValue({ count: 1 });
    prisma.projectUnit.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4);
    const r = await inv.setStatus('u1', { status: 'SOLD', reason: 'sold on call' }, 'ad', '1.1.1.1');
    expect(prisma.projectUnit.updateMany).toHaveBeenCalledWith({ where: { id: 'u1', status: 'AVAILABLE' }, data: { status: 'SOLD' } });
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'INVENTORY_UNIT_STATUS', reason: 'sold on call', before: { status: 'AVAILABLE' }, after: { status: 'SOLD' } });
    expect(prisma.property.updateMany.mock.calls[0][0]).toEqual({ where: { projectId: 'p1', propertyType: 'NEW_PROJECT' }, data: { totalUnits: 10, unitsLeft: 4 } });
    expect(r.status).toBe('SOLD');
  });
  test('an invoiced sold unit stays sold', async () => {
    prisma.projectUnit.findUnique.mockResolvedValue({ ...unit, status: 'SOLD' });
    prisma.builderInvoice.findUnique.mockResolvedValue({ id: 'inv1' });
    await expect(inv.setStatus('u1', { status: 'AVAILABLE', reason: 'because' }, 'ad', null)).rejects.toMatchObject({ statusCode: 409, data: { code: 'UNIT_INVOICED' } });
    expect(prisma.projectUnit.updateMany).not.toHaveBeenCalled();
  });
  test('losing a race is a 409', async () => {
    prisma.projectUnit.findUnique.mockResolvedValue(unit);
    prisma.projectUnit.updateMany.mockResolvedValue({ count: 0 });
    await expect(inv.setStatus('u1', { status: 'SOLD', reason: 'because' }, 'ad', null)).rejects.toMatchObject({ statusCode: 409 });
  });
  test('bulk: reports each unit, and refuses more than 200', async () => {
    prisma.projectUnit.findUnique.mockResolvedValueOnce(unit).mockResolvedValueOnce(null);
    prisma.projectUnit.updateMany.mockResolvedValue({ count: 1 });
    prisma.projectUnit.count.mockResolvedValue(3);
    const r = await inv.bulkSetStatus(['u1', 'u2'], { status: 'ON_HOLD', reason: 'show flats' }, 'ad', null);
    expect(r.changed).toBe(1);
    expect(r.failed).toHaveLength(1);
    await expect(inv.bulkSetStatus(Array.from({ length: 201 }, (_, i) => `id${i}`), { status: 'SOLD', reason: 'x'.repeat(6) }, 'ad', null)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('listing figures follow the units', () => {
  test('nothing is written for a project with no units', async () => {
    prisma.projectUnit.count.mockResolvedValue(0);
    await inv.syncProjectListingFigures('p1');
    expect(prisma.property.updateMany).not.toHaveBeenCalled();
  });
  test('a database error never escapes', async () => {
    prisma.projectUnit.count.mockRejectedValue(new Error('db'));
    await expect(inv.syncProjectListingFigures('p1')).resolves.toBeUndefined();
  });
  test('the builder path syncs after adding, editing, changing status and deleting', () => {
    const s = src('modules/projects/projectUnit.service.js');
    expect((s.match(/syncProjectListingFigures/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('import', () => {
  const row = (n, over = {}) => ({ unitNumber: n, unitType: 'FLAT', bhk: 2, price: 5000000, ...over });
  test('every row is checked on its own: invalid, repeated in the file, already in the project', async () => {
    prisma.projectUnit.findMany.mockResolvedValue([{ unitNumber: 'A-1' }]);
    const r = await inv.importUnits('p1', [row('A-2'), row('a-1'), row('A-2'), { unitNumber: '' }, row('A-3', { price: -5 })], { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, validCount: 1, errorCount: 4 });
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(prisma.projectUnit.create).not.toHaveBeenCalled();
  });
  test('a real import writes the valid rows, reports the rest, audits, and syncs', async () => {
    prisma.projectUnit.findMany.mockResolvedValue([]);
    prisma.projectUnit.create.mockImplementation(async ({ data }) => ({ id: data.unitNumber, ...data }));
    prisma.projectUnit.count.mockResolvedValue(2);
    const r = await inv.importUnits('p1', [row('A-1'), row('A-2')], { actor: { id: 'ad', role: 'ADMIN' } });
    expect(r).toMatchObject({ createdCount: 2, errorCount: 0 });
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'INVENTORY_UNITS_IMPORTED', actorRole: 'ADMIN' });
    expect(prisma.property.updateMany).toHaveBeenCalled();
  });
  test('size limits and empty files are refused', async () => {
    await expect(inv.importUnits('p1', [], {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(inv.importUnits('p1', Array.from({ length: 501 }, (_, i) => row(`U${i}`)), {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('export', () => {
  test('too many rows is refused; a normal export is audited', async () => {
    prisma.projectUnit.count.mockResolvedValueOnce(5001);
    await expect(inv.exportUnits({}, 'ad', null)).rejects.toMatchObject({ data: { code: 'EXPORT_TOO_LARGE' } });
    prisma.projectUnit.count.mockResolvedValueOnce(1);
    prisma.projectUnit.findMany.mockResolvedValue([{ id: 'u1', unitNumber: 'A-1', status: 'AVAILABLE', price: 100, updatedAt: new Date(), project: { title: 'P', city: 'B', publishStatus: 'APPROVED', builderId: 'b1' } }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'b1', name: 'B' }]);
    const r = await inv.exportUnits({ city: 'B' }, 'ad', null);
    expect(r.rows).toBe(1);
    expect(Buffer.from(r.buffer).slice(0, 2).toString()).toBe('PK');
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'INVENTORY_EXPORTED' });
  });
});

describe('routes', () => {
  const r = src('modules/admin/admin.routes.js');
  test('every inventory route needs the LISTINGS permission', () => {
    for (const frag of ["'/inventory',", "'/inventory/summary',", "'/inventory/export',", "'/inventory/units/bulk-status',", "'/projects/:id/units/import'", "'/properties/:id/availability'"]) {
      const line = r.split('\n').find((l) => l.includes(frag));
      expect(line).toBeTruthy();
      expect(line).toMatch(/requirePermission\('LISTINGS'\)/);
    }
  });
  test('the partner can change only their own listing, with KYC', () => {
    expect(src('modules/partners/partners.routes.js')).toMatch(/listings\/:id\/availability', requireKyc/);
  });
});

describe('single-listing availability', () => {
  const live = { id: 'a', title: 'T', slug: 't', partnerId: 'p1', publishStatus: 'APPROVED', listingType: 'SALE', availability: null };
  const partner = { id: 'p1', role: 'PARTNER' };
  const admin = { id: 'ad', role: 'ADMIN' };
  test('only the owner or an admin; only a live listing', async () => {
    prisma.property.findUnique.mockResolvedValue(live);
    await expect(avail.setAvailability('a', 'SOLD', { actor: { id: 'p9', role: 'PARTNER' } })).rejects.toMatchObject({ statusCode: 404 });
    prisma.property.findUnique.mockResolvedValue({ ...live, publishStatus: 'PENDING_APPROVAL' });
    await expect(avail.setAvailability('a', 'SOLD', { actor: partner })).rejects.toMatchObject({ data: { code: 'LISTING_NOT_LIVE' } });
  });
  test('sold is for sale listings, rented for rent and lease', async () => {
    prisma.property.findUnique.mockResolvedValue({ ...live, listingType: 'RENT' });
    await expect(avail.setAvailability('a', 'SOLD', { actor: partner })).rejects.toMatchObject({ data: { code: 'USE_RENTED' } });
    prisma.property.findUnique.mockResolvedValue(live);
    await expect(avail.setAvailability('a', 'RENTED', { actor: partner })).rejects.toMatchObject({ data: { code: 'USE_SOLD' } });
    await expect(avail.setAvailability('a', 'GONE', { actor: partner })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('marking sold is conditional, audited, and tells admins about open enquiries', async () => {
    prisma.property.findUnique.mockResolvedValue(live);
    prisma.property.updateMany.mockResolvedValue({ count: 1 });
    prisma.lead.count.mockResolvedValue(3);
    const r = await avail.setAvailability('a', 'SOLD', { note: 'sold directly', actor: partner, ip: '1.1.1.1' });
    expect(r).toMatchObject({ changed: true, openLeads: 3 });
    expect(prisma.property.updateMany.mock.calls[0][0].data.availability).toBe('SOLD');
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'LISTING_AVAILABILITY', actorRole: 'PARTNER', reason: 'sold directly' });
    expect(notifications.notifyAdmins).toHaveBeenCalled();
  });
  test('back to available clears the field; an admin may change any live listing; no change is a no-op; a lost race is a 409', async () => {
    prisma.property.findUnique.mockResolvedValue({ ...live, availability: 'ON_HOLD' });
    prisma.property.updateMany.mockResolvedValue({ count: 1 });
    await avail.setAvailability('a', 'AVAILABLE', { actor: admin });
    expect(prisma.property.updateMany.mock.calls[0][0].data.availability).toBeNull();
    prisma.property.findUnique.mockResolvedValue(live);
    expect((await avail.setAvailability('a', 'AVAILABLE', { actor: admin })).changed).toBe(false);
    prisma.property.updateMany.mockResolvedValue({ count: 0 });
    await expect(avail.setAvailability('a', 'ON_HOLD', { actor: admin })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('sold and rented listings leave search, featured and peers, and take no enquiries', () => {
    const s = src('modules/properties/properties.service.js');
    expect((s.match(/AND: \[SEARCHABLE, LIVE_PARTNER, ON_MARKET\]/g) || []).length).toBe(3);
    expect(src('modules/leads/leads.service.js')).toMatch(/LISTING_NOT_AVAILABLE/);
    expect(src('modules/leads/leads.service.js')).toMatch(/\.\.\.LIVE_PARTNER, \.\.\.ON_MARKET/);
  });
  test('the filter keeps a listing whose field is missing (a plain NOT-in matches nothing on MongoDB)', () => {
    expect(avail.ON_MARKET.OR).toEqual(expect.arrayContaining([{ availability: null }, { availability: { isSet: false } }]));
    expect(JSON.stringify(avail.ON_MARKET)).not.toMatch(/"NOT"/);
  });
});
