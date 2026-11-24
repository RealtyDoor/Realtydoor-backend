'use strict';

// The qualification pool (lib/poolLeads.js): a manager releases leads to Lead Dispatch, or moves them between groups. Only a person does this;
// no job and no import can. Every change is recorded on the lead and in the audit log.
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');

const MAX_PER_REQUEST = 500;
const GROUPS = ['A', 'B', 'C'];

function cleanIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((i) => /^[a-f\d]{24}$/i.test(i));
  if (!list.length) throw new ApiError(400, 'Pick at least one lead.');
  if (list.length > MAX_PER_REQUEST) throw new ApiError(400, `Pick ${MAX_PER_REQUEST} leads or fewer at a time.`);
  return list;
}

async function note(leadId, admin, text) {
  await prisma.leadNote.create({ data: { leadId, authorId: admin.id, authorName: admin.name || admin.email || 'Manager', kind: 'SYSTEM', text } });
}

/** Release pool leads to Lead Dispatch. Leads already released, or not in the pool, are left alone. */
async function releaseLeads(ids, admin, ip) {
  const list = cleanIds(ids);
  const leads = await prisma.lead.findMany({ where: { id: { in: list }, poolBatch: { isSet: true }, poolReleasedAt: { isSet: false } }, select: { id: true, poolGroup: true } });
  const now = new Date();
  let released = 0;
  for (const l of leads) {
    const r = await prisma.lead.updateMany({
      where: { id: l.id, poolReleasedAt: { isSet: false } },
      data: { poolReleasedAt: now, salesStage: 'QUALIFIED', qualifiedAt: now, notQualifiedReason: null, ...(l.poolGroup === 'C' ? { poolGroup: 'A', poolGroupReason: 'Released by a manager' } : {}) },
    });
    if (r.count) { released += 1; await note(l.id, admin, 'Released from the qualification pool to Lead Dispatch.'); }
  }
  createAuditLog({ adminId: admin.id, action: 'LEAD_POOL_RELEASE', targetType: 'Lead', targetId: list[0], metadata: { count: released, requested: list.length }, ipAddress: ip }).catch(() => null);
  return { released, skipped: list.length - released };
}

/** Move pool leads to another group (A promote after review, B call first, C archive). */
async function moveGroup(ids, group, admin, ip) {
  if (!GROUPS.includes(group)) throw new ApiError(400, 'Unknown group.');
  const list = cleanIds(ids);
  const r = await prisma.lead.updateMany({
    where: { id: { in: list }, poolBatch: { isSet: true }, poolReleasedAt: { isSet: false } },
    data: { poolGroup: group, poolGroupReason: 'Moved by a manager' },
  });
  createAuditLog({ adminId: admin.id, action: 'LEAD_POOL_MOVE', targetType: 'Lead', targetId: list[0], metadata: { count: r.count, group }, ipAddress: ip }).catch(() => null);
  return { moved: r.count };
}

module.exports = { releaseLeads, moveGroup, MAX_PER_REQUEST };
