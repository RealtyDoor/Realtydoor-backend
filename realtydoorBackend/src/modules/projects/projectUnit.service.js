const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { notifyAdmins } = require('../../lib/notifications');

// Inventory management is independent of the project's own approval status
// (4.10/R23) — a builder's compliance documents were vetted once at project
// approval; adding units, correcting a price, or marking one SOLD is routine
// inventory upkeep, not a fresh compliance event. Units simply have no public
// visibility at all until the parent project is APPROVED (gated in
// project.service.js's search/detail reads), regardless of unit status.

async function assertOwnsProject(projectId, builderId) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { builderId: true } });
  if (!project) throw new ApiError(404, 'Project not found');
  if (project.builderId !== builderId) throw new ApiError(403, 'Not your project');
  return project;
}

const UNIT_FIELDS = ['unitNumber', 'unitType', 'bhk', 'carpetArea', 'builtUpArea', 'price', 'floorNumber'];

function pickUnitFields(data) {
  return Object.fromEntries(Object.entries(data).filter(([k]) => UNIT_FIELDS.includes(k)));
}

async function addUnit(projectId, builderId, data) {
  await assertOwnsProject(projectId, builderId);
  try {
    return await prisma.projectUnit.create({ data: { ...pickUnitFields(data), projectId } });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `Unit "${data.unitNumber}" already exists in this project`);
    throw err;
  }
}

// Builders enter inventory in bulk, not one row at a time (a real project
// can have hundreds of units) — one call, one response reporting both
// successes and the specific rows that collided, so a single duplicate
// doesn't silently drop the rest of a large batch.
async function bulkAddUnits(projectId, builderId, units) {
  await assertOwnsProject(projectId, builderId);
  const created = [];
  const failed = [];
  for (const u of units) {
    try {
      created.push(await prisma.projectUnit.create({ data: { ...pickUnitFields(u), projectId } }));
    } catch (err) {
      if (err.code === 'P2002') failed.push({ unitNumber: u.unitNumber, reason: 'duplicate unit number' });
      else failed.push({ unitNumber: u.unitNumber, reason: err.message });
    }
  }
  return { createdCount: created.length, failedCount: failed.length, created, failed };
}

async function updateUnit(projectId, unitId, builderId, data) {
  await assertOwnsProject(projectId, builderId);
  const unit = await prisma.projectUnit.findFirst({ where: { id: unitId, projectId } });
  if (!unit) throw new ApiError(404, 'Unit not found in this project');
  // Audit Nov 2026 (P9). The brokerage is charged on the unit's price, so the price of a sold unit is not the builder's
  // to change: before this, a builder could mark a unit SOLD and lower its price ahead of the invoice.
  const fields = pickUnitFields(data);
  if (unit.status === 'SOLD' && fields.price !== undefined && fields.price !== unit.price) {
    throw new ApiError(409, 'This unit is sold, so its price can no longer be changed. Contact support if the price was entered wrongly.', { code: 'UNIT_SOLD_PRICE_LOCKED' });
  }
  return prisma.projectUnit.update({ where: { id: unitId }, data: fields });
}

async function setUnitStatus(projectId, unitId, builderId, status) {
  await assertOwnsProject(projectId, builderId);
  const unit = await prisma.projectUnit.findFirst({ where: { id: unitId, projectId } });
  if (!unit) throw new ApiError(404, 'Unit not found in this project');
  if (unit.status === status) return unit;
  // Audit Nov 2026 (P9). Once the brokerage invoice exists the sale is on record: only an admin can reopen it.
  // Before the invoice, un-selling stays possible (a wrong click), but the admins are told, because "sold, then not sold"
  // is also how a brokerage would be avoided.
  if (unit.status === 'SOLD') {
    const invoice = await prisma.builderInvoice.findUnique({ where: { unitId }, select: { id: true } });
    if (invoice) {
      throw new ApiError(409, 'A brokerage invoice has been raised for this unit, so it stays sold. Contact support to reopen it.', { code: 'UNIT_INVOICED' });
    }
  }
  // Conditional on the status we read, so two changes at once do not both apply.
  const moved = await prisma.projectUnit.updateMany({ where: { id: unitId, status: unit.status }, data: { status } });
  if (!moved.count) throw new ApiError(409, 'This unit was just changed. Reload and try again.');
  if (unit.status === 'SOLD') {
    notifyAdmins({
      title: 'Sold unit reopened by the builder',
      message: `Unit ${unit.unitNumber} was moved from SOLD back to ${status} before a brokerage invoice was raised.`,
      type: 'PROJECT_UNIT_REOPENED',
      linkUrl: `/admin/projects/${projectId}`,
    }).catch(() => {});
  }
  return prisma.projectUnit.findUnique({ where: { id: unitId } });
}

async function deleteUnit(projectId, unitId, builderId) {
  await assertOwnsProject(projectId, builderId);
  const unit = await prisma.projectUnit.findFirst({ where: { id: unitId, projectId } });
  if (!unit) throw new ApiError(404, 'Unit not found in this project');
  if (unit.status !== 'AVAILABLE') {
    throw new ApiError(400, `Cannot delete a unit that is ${unit.status} — set it back to AVAILABLE first if this was entered in error`);
  }
  return prisma.projectUnit.delete({ where: { id: unitId } });
}

module.exports = { addUnit, bulkAddUnits, updateUnit, setUnitStatus, deleteUnit };
