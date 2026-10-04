const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');

// 4.11 — "all units go live together". Approving touches only Project; there
// is no per-unit approval at all, so every AVAILABLE unit becomes visible
// the instant publishStatus flips to APPROVED, and none before.
async function approveProject(id, adminId, ip) {
  const project = await prisma.project.findUnique({ where: { id }, include: { _count: { select: { units: true } } } });
  if (!project) throw new ApiError(404, 'Project not found');

  const updated = await prisma.project.update({
    where: { id },
    data: {
      publishStatus: 'APPROVED', rejectionNote: null,
      requestedChanges: [], requestedChangesNote: null, changesRequestedAt: null, changesRequestedByAdminId: null,
      reviewedByAdminId: adminId, reviewedAt: new Date(),
    },
  });

  await createNotification({
    userId: project.builderId,
    title: 'Project approved',
    message: `"${project.title}" is now live, with all ${project._count.units} unit(s).`,
    type: 'PROPERTY_APPROVED',
    linkUrl: `/partner/projects/${id}`,
  });

  await createAuditLog({
    adminId, action: 'PROJECT_APPROVED', targetType: 'Project', targetId: id,
    before: { publishStatus: project.publishStatus }, after: { publishStatus: 'APPROVED' }, ipAddress: ip,
  });

  return updated;
}

async function rejectProject(id, note, adminId, ip) {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new ApiError(404, 'Project not found');

  const updated = await prisma.project.update({
    where: { id },
    data: { publishStatus: 'REJECTED', rejectionNote: note, reviewedByAdminId: adminId, reviewedAt: new Date() },
  });

  await createNotification({
    userId: project.builderId,
    title: 'Project rejected',
    message: `"${project.title}" was not approved. Reason: ${note}`,
    type: 'PROPERTY_REJECTED',
    linkUrl: `/partner/projects/${id}`,
  });

  await createAuditLog({
    adminId, action: 'PROJECT_REJECTED', targetType: 'Project', targetId: id,
    after: { publishStatus: 'REJECTED', note }, ipAddress: ip,
  });

  return updated;
}

// 4.15's equivalent for a project — same CHANGES_REQUESTED pattern as
// Property (listings routes/admin.service.js), refused on an already-live
// project for the same reason: pulling a live, fully-sold-into project back
// into review as a side effect of asking for one fix is rarely the intent.
async function requestProjectChanges(id, { items, note }, adminId, ip) {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new ApiError(404, 'Project not found');
  if (project.publishStatus === 'APPROVED') {
    throw new ApiError(400,
      'This project is live. Requesting changes would pull all its units out of public view. '
      + 'Edit it directly, or reject it if it should come down.');
  }

  const updated = await prisma.project.update({
    where: { id },
    data: {
      publishStatus: 'CHANGES_REQUESTED', requestedChanges: items, requestedChangesNote: note || null,
      changesRequestedAt: new Date(), changesRequestedByAdminId: adminId, rejectionNote: null,
    },
  });

  await createNotification({
    userId: project.builderId,
    title: 'Changes requested on your project',
    message: `Admin asked for ${items.length} fix(es) on "${project.title}"${note ? `: ${note}` : ''}`,
    type: 'PROPERTY_CHANGES_REQUESTED',
    linkUrl: `/partner/projects/${id}`,
  });

  await createAuditLog({
    adminId, action: 'PROJECT_CHANGES_REQUESTED', targetType: 'Project', targetId: id,
    after: { publishStatus: 'CHANGES_REQUESTED', items, note: note || null }, ipAddress: ip,
  });

  return updated;
}

// Per-approval-item review (RERA plan / commencement certificate / land
// title) — the admin review screen needs to accept or reject each document
// independently, not just the project as a whole.
const APPROVAL_FIELD_MAP = {
  approvedPlan: 'approvedPlanStatus',
  commencement: 'commencementStatus',
  landTitle: 'landTitleStatus',
};

async function setApprovalItemStatus(id, item, status, adminId, ip) {
  const field = APPROVAL_FIELD_MAP[item];
  if (!field) throw new ApiError(400, `Unknown approval item "${item}" — must be one of ${Object.keys(APPROVAL_FIELD_MAP).join(', ')}`);
  if (!['APPROVED', 'REJECTED'].includes(status)) throw new ApiError(400, 'status must be APPROVED or REJECTED');

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new ApiError(404, 'Project not found');

  const updated = await prisma.project.update({ where: { id }, data: { [field]: status } });

  await createAuditLog({
    adminId, action: 'PROJECT_APPROVAL_ITEM_REVIEWED', targetType: 'Project', targetId: id,
    before: { [field]: project[field] }, after: { [field]: status, item }, ipAddress: ip,
  });

  return updated;
}

// R28 — the brokerage rate RealtyDoor charges this builder, deliberately
// admin-only: a builder setting their own fee is the same conflict-of-
// interest 3.17 already guards against on the Lead-commission side.
async function setBrokeragePct(id, brokeragePct, adminId, ip) {
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, brokeragePct: true } });
  if (!project) throw new ApiError(404, 'Project not found');

  const updated = await prisma.project.update({ where: { id }, data: { brokeragePct } });

  await createAuditLog({
    adminId, action: 'PROJECT_BROKERAGE_SET', targetType: 'Project', targetId: id,
    before: { brokeragePct: project.brokeragePct }, after: { brokeragePct }, ipAddress: ip,
  });

  return updated;
}

module.exports = {
  approveProject, rejectProject, requestProjectChanges, setApprovalItemStatus, setBrokeragePct,
  APPROVAL_FIELD_MAP,
};
