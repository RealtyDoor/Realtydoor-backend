const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const projectSvc = require('./project.service');
const unitSvc = require('./projectUnit.service');
const adminSvc = require('./project.admin.service');
const {
  createProjectSchema, updateProjectSchema, bulkAddUnitsSchema, unitSchema, setUnitStatusSchema,
  rejectProjectSchema, requestProjectChangesSchema, setApprovalItemSchema, setBrokerageSchema, adminStatusSchema, adminBulkStatusSchema,
} = require('./project.validator');
const inventorySvc = require('./inventory.service');

// ─── Public ───────────────────────────────────────────────────────────────────

async function search(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await projectSvc.searchProjects(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getBySlug(req, res, next) {
  try {
    success(res, await projectSvc.getProjectBySlug(req.params.slug));
  } catch (err) { next(err); }
}

// ─── Partner (builder) ────────────────────────────────────────────────────────

async function create(req, res, next) {
  try {
    const data = createProjectSchema.parse(req.body);
    created(res, await projectSvc.createProject(data, req.user.id), 'Project submitted for review');
  } catch (err) { next(err); }
}

async function getMine(req, res, next) {
  try {
    success(res, await projectSvc.getMyProject(req.params.id, req.user.id));
  } catch (err) { next(err); }
}

async function listMine(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await projectSvc.listMyProjects(req.user.id, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const data = updateProjectSchema.parse(req.body);
    success(res, await projectSvc.updateProject(req.params.id, req.user.id, data), 'Project updated');
  } catch (err) { next(err); }
}

async function addUnit(req, res, next) {
  try {
    const data = unitSchema.parse(req.body);
    created(res, await unitSvc.addUnit(req.params.id, req.user.id, data), 'Unit added');
  } catch (err) { next(err); }
}

async function bulkAddUnits(req, res, next) {
  try {
    const { units, dryRun } = bulkAddUnitsSchema.parse(req.body);
    const result = await unitSvc.bulkAddUnits(req.params.id, req.user.id, units, { dryRun, ip: req.ip });
    if (result.dryRun) return success(res, result, `${result.validCount} unit(s) ready to add, ${result.errorCount} refused`);
    created(res, result, `${result.createdCount} unit(s) added${result.failedCount ? `, ${result.failedCount} failed` : ''}`);
  } catch (err) { next(err); }
}

async function updateUnit(req, res, next) {
  try {
    const data = unitSchema.partial().parse(req.body);
    success(res, await unitSvc.updateUnit(req.params.id, req.params.unitId, req.user.id, data), 'Unit updated');
  } catch (err) { next(err); }
}

async function setUnitStatus(req, res, next) {
  try {
    const { status } = setUnitStatusSchema.parse(req.body);
    success(res, await unitSvc.setUnitStatus(req.params.id, req.params.unitId, req.user.id, status), `Unit marked ${status}`);
  } catch (err) { next(err); }
}

async function deleteUnit(req, res, next) {
  try {
    success(res, await unitSvc.deleteUnit(req.params.id, req.params.unitId, req.user.id), 'Unit removed');
  } catch (err) { next(err); }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

async function listAdmin(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await projectSvc.listProjectsAdmin(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getAdmin(req, res, next) {
  try {
    success(res, await projectSvc.getProject(req.params.id));
  } catch (err) { next(err); }
}

async function approve(req, res, next) {
  try {
    success(res, await adminSvc.approveProject(req.params.id, req.user.id, req.ip), 'Project approved — all units now live');
  } catch (err) { next(err); }
}

async function reject(req, res, next) {
  try {
    const { note } = rejectProjectSchema.parse(req.body);
    success(res, await adminSvc.rejectProject(req.params.id, note, req.user.id, req.ip), 'Project rejected');
  } catch (err) { next(err); }
}

async function requestChanges(req, res, next) {
  try {
    const { items, note } = requestProjectChangesSchema.parse(req.body);
    const result = await adminSvc.requestProjectChanges(req.params.id, { items, note }, req.user.id, req.ip);
    success(res, result, `Requested ${items.length} change(s)`);
  } catch (err) { next(err); }
}

async function setApprovalItem(req, res, next) {
  try {
    const { status } = setApprovalItemSchema.parse(req.body);
    const result = await adminSvc.setApprovalItemStatus(req.params.id, req.params.item, status, req.user.id, req.ip);
    success(res, result, `${req.params.item} marked ${status}`);
  } catch (err) { next(err); }
}

// R28
async function setBrokerage(req, res, next) {
  try {
    const { brokeragePct } = setBrokerageSchema.parse(req.body);
    success(res, await adminSvc.setBrokeragePct(req.params.id, brokeragePct, req.user.id, req.ip), 'Brokerage rate set');
  } catch (err) { next(err); }
}

// ─── Admin inventory ──────────────────────────────────────────────────────────

async function inventoryList(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination({ ...req.query, limit: req.query.limit || '50' });
    const { data, total } = await inventorySvc.listUnits(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function inventorySummary(req, res, next) {
  try { success(res, await inventorySvc.summary(req.query)); } catch (err) { next(err); }
}

async function inventorySetStatus(req, res, next) {
  try {
    const body = adminStatusSchema.parse(req.body);
    success(res, await inventorySvc.setStatus(req.params.unitId, body, req.user.id, req.ip), `Unit marked ${body.status}`);
  } catch (err) { next(err); }
}

async function inventoryBulkStatus(req, res, next) {
  try {
    const { unitIds, ...body } = adminBulkStatusSchema.parse(req.body);
    success(res, await inventorySvc.bulkSetStatus(unitIds, body, req.user.id, req.ip));
  } catch (err) { next(err); }
}

async function inventoryExport(req, res, next) {
  try {
    const { buffer, rows } = await inventorySvc.exportUnits(req.query, req.user.id, req.ip);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="realtydoor-inventory-${stamp}.xlsx"`,
      'Cache-Control': 'private, no-store',
      'X-Row-Count': String(rows),
    });
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
}

async function inventoryImport(req, res, next) {
  try {
    const { units, dryRun } = bulkAddUnitsSchema.parse(req.body);
    success(res, await inventorySvc.importUnits(req.params.id, units, { dryRun, actor: { id: req.user.id, role: 'ADMIN' }, ip: req.ip }));
  } catch (err) { next(err); }
}

module.exports = {
  inventoryList, inventorySummary, inventorySetStatus, inventoryBulkStatus, inventoryExport, inventoryImport,
  search, getBySlug,
  create, getMine, listMine, update, addUnit, bulkAddUnits, updateUnit, setUnitStatus, deleteUnit,
  listAdmin, getAdmin, approve, reject, requestChanges, setApprovalItem, setBrokerage,
};
