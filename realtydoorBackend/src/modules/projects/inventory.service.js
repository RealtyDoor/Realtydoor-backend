'use strict';

// Inventory management (units of builder projects), the admin side and the pieces both sides share.
// Builders keep working through projectUnit.service.js; this adds what an admin needs: one list across every project, a status
// change with a reason, bulk status change, an Excel export, a checked CSV import, and keeping the figures on a project's
// public listing equal to the real unit rows.

const ExcelJS = require('exceljs');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const { cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { unitSchema } = require('./project.validator');

const STATUSES = ['AVAILABLE', 'ON_HOLD', 'BOOKED', 'SOLD'];
const EXPORT_MAX = 5000;
const BULK_MAX = 200;
const IMPORT_MAX = 500;

// A "New project" listing carries total and left-over unit counts that used to be typed by hand and drifted from the real
// inventory. When a project's units change, the listings linked to that project take their counts from the unit rows.
// Never throws: the unit change has already happened, and a stale count heals on the next change.
async function syncProjectListingFigures(projectId) {
  try {
    const [total, available] = await Promise.all([
      prisma.projectUnit.count({ where: { projectId } }),
      prisma.projectUnit.count({ where: { projectId, status: 'AVAILABLE' } }),
    ]);
    if (!total) return;
    await prisma.property.updateMany({ where: { projectId, propertyType: 'NEW_PROJECT' }, data: { totalUnits: total, unitsLeft: available } });
    cacheDel(CACHE_KEYS.FEATURED_PROPERTIES);
  } catch (err) {
    logger.warn('[Inventory] could not update the listing figures', { projectId, error: err.message });
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function unitWhere(q = {}) {
  const where = {};
  if (q.projectId) where.projectId = q.projectId;
  if (STATUSES.includes(q.status)) where.status = q.status;
  if (q.unitType) where.unitType = q.unitType;
  if (q.bhk !== undefined && q.bhk !== '' && Number.isInteger(Number(q.bhk))) where.bhk = Number(q.bhk);
  const min = Number(q.minPrice); const max = Number(q.maxPrice);
  if (q.minPrice && Number.isFinite(min)) where.price = { ...(where.price || {}), gte: min };
  if (q.maxPrice && Number.isFinite(max)) where.price = { ...(where.price || {}), lte: max };
  if (q.q) where.unitNumber = { contains: String(q.q).slice(0, 50), mode: 'insensitive' };
  const project = {};
  if (q.builderId) project.builderId = q.builderId;
  if (q.city) project.city = { equals: String(q.city).slice(0, 100), mode: 'insensitive' };
  if (q.projectStatus) project.publishStatus = q.projectStatus;
  if (Object.keys(project).length) where.project = { is: project };
  return where;
}

const UNIT_INCLUDE = {
  project: { select: { id: true, title: true, slug: true, city: true, locality: true, publishStatus: true, builderId: true } },
};

async function withBuilders(units) {
  const ids = [...new Set(units.map((u) => u.project?.builderId).filter(Boolean))];
  const builders = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, companyName: true } }) : [];
  const byId = new Map(builders.map((b) => [b.id, b]));
  return units.map((u) => ({ ...u, builder: byId.get(u.project?.builderId) || null }));
}

async function listUnits(query, skip, limit) {
  const where = unitWhere(query);
  const [units, total] = await Promise.all([
    prisma.projectUnit.findMany({ where, skip, take: limit, orderBy: [{ projectId: 'asc' }, { unitNumber: 'asc' }], include: UNIT_INCLUDE }),
    prisma.projectUnit.count({ where }),
  ]);
  return { data: await withBuilders(units), total };
}

// Counts and value per status for the same filters (the status filter itself is left out so the strip always shows all four).
async function summary(query) {
  const { status: _ignored, ...rest } = query || {};
  const base = unitWhere(rest);
  const out = {};
  await Promise.all(STATUSES.map(async (s) => {
    const where = { ...base, status: s };
    const [count, agg] = await Promise.all([prisma.projectUnit.count({ where }), prisma.projectUnit.aggregate({ where, _sum: { price: true } })]);
    out[s] = { count, value: agg._sum.price || 0 };
  }));
  const total = STATUSES.reduce((n, s) => n + out[s].count, 0);
  return { total, byStatus: out };
}

// ─── Status changes ──────────────────────────────────────────────────────────

async function changeStatusOne(unitId, status, reason, adminId, ip) {
  const unit = await prisma.projectUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new ApiError(404, 'Unit not found');
  if (unit.status === status) return { unit, changed: false };
  if (unit.status === 'SOLD') {
    const invoice = await prisma.builderInvoice.findUnique({ where: { unitId }, select: { id: true } });
    if (invoice) {
      throw new ApiError(409, 'A brokerage invoice exists for this unit, so it stays sold. Deal with the invoice first.', { code: 'UNIT_INVOICED' });
    }
  }
  const moved = await prisma.projectUnit.updateMany({ where: { id: unitId, status: unit.status }, data: { status } });
  if (!moved.count) throw new ApiError(409, 'This unit was just changed. Reload and try again.', { code: 'UNIT_CHANGED' });
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'INVENTORY_UNIT_STATUS', targetType: 'ProjectUnit', targetId: unitId,
    before: { status: unit.status }, after: { status }, reason, ipAddress: ip, metadata: { projectId: unit.projectId, unitNumber: unit.unitNumber },
  }).catch((err) => logger.warn('[Inventory] audit write failed', { unitId, error: err.message }));
  await syncProjectListingFigures(unit.projectId);
  return { unit: { ...unit, status }, changed: true };
}

async function setStatus(unitId, { status, reason }, adminId, ip) {
  const { unit } = await changeStatusOne(unitId, status, reason, adminId, ip);
  return unit;
}

// Up to BULK_MAX units; each is its own change with its own audit row, and the answer says which went through and which did not.
async function bulkSetStatus(unitIds, { status, reason }, adminId, ip) {
  const ids = [...new Set(unitIds)];
  if (ids.length > BULK_MAX) throw new ApiError(400, `Change at most ${BULK_MAX} units at a time.`, { code: 'BULK_TOO_LARGE' });
  const results = [];
  for (const id of ids) {
    try {
      const r = await changeStatusOne(id, status, reason, adminId, ip);
      results.push({ id, ok: true, changed: r.changed });
    } catch (err) {
      results.push({ id, ok: false, reason: err.message });
    }
  }
  return { changed: results.filter((r) => r.ok && r.changed).length, unchanged: results.filter((r) => r.ok && !r.changed).length, failed: results.filter((r) => !r.ok), results };
}

// ─── Export ──────────────────────────────────────────────────────────────────

const COLUMNS = [
  ['Project', 30], ['Builder', 24], ['City', 14], ['Project status', 16], ['Unit', 12], ['Type', 18], ['BHK', 6], ['Floor', 7],
  ['Carpet area (sq ft)', 16], ['Built-up area (sq ft)', 18], ['Price (INR)', 16], ['Status', 12], ['Last changed', 14],
];

async function exportUnits(query, adminId, ip) {
  const where = unitWhere(query);
  const total = await prisma.projectUnit.count({ where });
  if (total > EXPORT_MAX) throw new ApiError(400, `That is ${total} units. Narrow the filters to ${EXPORT_MAX} or fewer, then export again.`, { code: 'EXPORT_TOO_LARGE' });
  const units = await withBuilders(await prisma.projectUnit.findMany({ where, take: EXPORT_MAX, orderBy: [{ projectId: 'asc' }, { unitNumber: 'asc' }], include: UNIT_INCLUDE }));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Realtydoor'; wb.created = new Date();
  const ws = wb.addWorksheet('Inventory', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C2FEE' } };
  for (const u of units) {
    const row = ws.addRow([
      u.project?.title || '', u.builder?.companyName || u.builder?.name || '', u.project?.city || '', u.project?.publishStatus || '',
      u.unitNumber, u.unitType || '', u.bhk ?? null, u.floorNumber ?? null, u.carpetArea ?? null, u.builtUpArea ?? null, u.price ?? null, u.status,
      u.updatedAt ? new Date(u.updatedAt) : null,
    ]);
    row.getCell(13).numFmt = 'dd-mmm-yyyy';
    row.getCell(11).numFmt = '#,##0';
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  const buffer = await wb.xlsx.writeBuffer();
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'INVENTORY_EXPORTED', targetType: 'export', targetId: 'inventory',
    ipAddress: ip, metadata: { rows: units.length, filters: Object.keys(query || {}).filter((k) => query[k]) },
  }).catch(() => null);
  return { buffer, rows: units.length };
}

// ─── Import (shared by the builder and the admin) ────────────────────────────

// Checks every row on its own, so one bad row does not hold back the rest: a row is refused when it is not a valid unit, repeats a
// unit number earlier in the same file, or repeats a unit number already in the project.
async function planImport(projectId, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(400, 'No rows to import.', { code: 'NO_ROWS' });
  if (rows.length > IMPORT_MAX) throw new ApiError(400, `Import at most ${IMPORT_MAX} units at a time.`, { code: 'IMPORT_TOO_LARGE' });
  const existing = new Set((await prisma.projectUnit.findMany({ where: { projectId }, select: { unitNumber: true } })).map((u) => u.unitNumber.toLowerCase()));
  const seen = new Set();
  const valid = [];
  const errors = [];
  rows.forEach((raw, i) => {
    const parsed = unitSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: i + 1, unitNumber: raw?.unitNumber ?? '', reason: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
      return;
    }
    const key = parsed.data.unitNumber.toLowerCase();
    if (seen.has(key)) { errors.push({ row: i + 1, unitNumber: parsed.data.unitNumber, reason: 'repeated in this file' }); return; }
    if (existing.has(key)) { errors.push({ row: i + 1, unitNumber: parsed.data.unitNumber, reason: 'already in this project' }); return; }
    seen.add(key);
    valid.push({ row: i + 1, data: parsed.data });
  });
  return { valid, errors };
}

async function importUnits(projectId, rows, { dryRun = false, actor = null, ip = null } = {}) {
  const plan = await planImport(projectId, rows);
  if (dryRun) return { dryRun: true, validCount: plan.valid.length, errorCount: plan.errors.length, errors: plan.errors };
  const created = [];
  const errors = [...plan.errors];
  for (const v of plan.valid) {
    try {
      created.push(await prisma.projectUnit.create({ data: { ...v.data, projectId } }));
    } catch (err) {
      errors.push({ row: v.row, unitNumber: v.data.unitNumber, reason: err.code === 'P2002' ? 'already in this project' : err.message });
    }
  }
  if (created.length) {
    await syncProjectListingFigures(projectId);
    await createAuditLog({
      adminId: actor?.id ?? null, actorRole: actor?.role || 'PARTNER', action: 'INVENTORY_UNITS_IMPORTED', targetType: 'Project', targetId: projectId,
      ipAddress: ip, metadata: { created: created.length, refused: errors.length },
    }).catch(() => null);
  }
  return { dryRun: false, createdCount: created.length, errorCount: errors.length, errors };
}

module.exports = {
  STATUSES, syncProjectListingFigures, unitWhere, listUnits, summary, setStatus, bulkSetStatus, exportUnits, planImport, importUnits,
};
