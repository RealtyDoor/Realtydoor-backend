const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const { sendTemplateMessage } = require('../../lib/wati');
const { maskPhone } = require('../../lib/phoneUtils');

// Only an APPROVED template can actually deliver — Meta rejects the rest. The
// test-send and any future event wiring check against this.
const SENDABLE_STATUS = 'APPROVED';

// ─── 12.1 / 12.2 — template catalogue ────────────────────────────────────────

async function listTemplates(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.search) where.OR = [
    { name:        { contains: filters.search, mode: 'insensitive' } },
    { displayName: { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total] = await Promise.all([
    prisma.watiTemplate.findMany({ where, skip, take: limit, orderBy: { updatedAt: 'desc' } }),
    prisma.watiTemplate.count({ where }),
  ]);

  // 12.3 — delivery stats per template, from the log rather than stored
  // counters (which would drift). One grouped query for the whole page
  // instead of two per row.
  const names = data.map((t) => t.name);
  const stats = await deliveryStatsFor(names);
  return { data: data.map((t) => ({ ...t, delivery: stats[t.name] })), total };
}

async function getTemplateById(id) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');
  const stats = await deliveryStatsFor([tpl.name]);
  return { ...tpl, delivery: stats[tpl.name] };
}

async function createTemplate(data, adminId, ip) {
  const existing = await prisma.watiTemplate.findUnique({ where: { name: data.name } });
  if (existing) throw new ApiError(409, 'A template with this name already exists');

  const tpl = await prisma.watiTemplate.create({
    data: { ...data, lastEditedByAdminId: adminId },
  });
  await createAuditLog({
    adminId, action: 'WATI_TEMPLATE_CREATED', targetType: 'WatiTemplate', targetId: tpl.id,
    after: { name: tpl.name, status: tpl.status }, ipAddress: ip,
  });
  return tpl;
}

async function updateTemplate(id, data, adminId, ip) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');

  const updated = await prisma.watiTemplate.update({
    where: { id },
    // Editing an approved template's content invalidates Meta's approval —
    // it has to be resubmitted — so the status drops back to DRAFT rather
    // than silently continuing to claim APPROVED.
    data: {
      ...data,
      lastEditedByAdminId: adminId,
      ...(tpl.status === 'APPROVED' && (data.body || data.variables) ? { status: 'DRAFT' } : {}),
    },
  });

  await createAuditLog({
    adminId, action: 'WATI_TEMPLATE_UPDATED', targetType: 'WatiTemplate', targetId: id,
    before: { status: tpl.status, body: tpl.body },
    after: { status: updated.status, body: updated.body }, ipAddress: ip,
  });
  return updated;
}

async function deleteTemplate(id, adminId, ip) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');

  await prisma.watiTemplate.delete({ where: { id } });
  await createAuditLog({
    adminId, action: 'WATI_TEMPLATE_DELETED', targetType: 'WatiTemplate', targetId: id,
    before: { name: tpl.name }, ipAddress: ip,
  });
  // The message log deliberately keeps rows for a deleted template — the
  // delivery history is what it's for, and templateName is a plain string
  // precisely so deleting the catalogue entry can't orphan it.
  return { deleted: true, name: tpl.name };
}

// 12.2 — mark as submitted to Meta. We don't call Meta's API (WATI owns that
// relationship); this records that a human submitted it, so the queue is
// visible. Meta's verdict comes back via syncTemplateStatus below.
async function submitTemplate(id, adminId, ip) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');
  if (tpl.status === 'PENDING_META') throw new ApiError(400, 'This template is already awaiting Meta review');
  if (tpl.status === SENDABLE_STATUS) throw new ApiError(400, 'This template is already approved');

  const updated = await prisma.watiTemplate.update({
    where: { id },
    data: { status: 'PENDING_META', submittedAt: new Date(), lastEditedByAdminId: adminId },
  });
  await createAuditLog({
    adminId, action: 'WATI_TEMPLATE_SUBMITTED', targetType: 'WatiTemplate', targetId: id,
    before: { status: tpl.status }, after: { status: 'PENDING_META' }, ipAddress: ip,
  });
  return updated;
}

async function syncTemplateStatus(id, status, adminId, ip) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');

  const updated = await prisma.watiTemplate.update({ where: { id }, data: { status } });
  await createAuditLog({
    adminId, action: 'WATI_TEMPLATE_STATUS_SYNCED', targetType: 'WatiTemplate', targetId: id,
    before: { status: tpl.status }, after: { status }, ipAddress: ip,
  });
  return updated;
}

// ─── 12.4 — test send ────────────────────────────────────────────────────────

async function testSend(id, phone, variables, adminId, ip) {
  const tpl = await prisma.watiTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');
  if (tpl.status !== SENDABLE_STATUS) {
    throw new ApiError(400, `Only an APPROVED template can be sent (this one is ${tpl.status})`, { code: 'TEMPLATE_NOT_APPROVED' });
  }

  // Fail before calling WATI if a declared variable has no value — WATI's own
  // error for this is opaque, and a half-filled template reaches a real phone.
  const missing = (tpl.variables || []).filter((v) => !(v in (variables || {})));
  if (missing.length) {
    throw new ApiError(400, `Missing values for template variables: ${missing.join(', ')}`, { code: 'MISSING_VARIABLES' });
  }

  const parameters = (tpl.variables || []).map((name) => ({ name, value: String(variables[name]) }));
  await sendTemplateMessage(phone, tpl.name, parameters);

  await createAuditLog({
    adminId, action: 'WATI_TEST_SEND', targetType: 'WatiTemplate', targetId: id,
    after: { templateName: tpl.name, to: maskPhone(phone) }, ipAddress: ip,
  });
  return { sent: true, templateName: tpl.name, to: maskPhone(phone) };
}

// ─── 12.3 / 12.5 / 12.6 — delivery log and stats ─────────────────────────────

// Delivery % counts anything that reached the handset (DELIVERED/READ/
// RESPONDED) over everything we attempted. SENT alone isn't success — it only
// means WATI accepted the call.
const REACHED = ['DELIVERED', 'READ', 'RESPONDED'];

async function deliveryStatsFor(templateNames) {
  if (!templateNames.length) return {};
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  const [grouped, recent, lastSends] = await Promise.all([
    prisma.watiMessageLog.groupBy({
      by: ['templateName', 'status'],
      where: { templateName: { in: templateNames } },
      _count: { status: true },
    }),
    prisma.watiMessageLog.groupBy({
      by: ['templateName'],
      where: { templateName: { in: templateNames }, sentAt: { gte: sevenDaysAgo } },
      _count: { templateName: true },
    }),
    prisma.watiMessageLog.findMany({
      where: { templateName: { in: templateNames } },
      orderBy: { sentAt: 'desc' },
      distinct: ['templateName'],
      select: { templateName: true, sentAt: true },
    }),
  ]);

  const out = Object.fromEntries(templateNames.map((n) => ({ n })).map(({ n }) => [n, {
    total: 0, reached: 0, failed: 0, deliveryPct: null, sends7d: 0, lastSentAt: null,
  }]));

  for (const row of grouped) {
    const t = out[row.templateName];
    if (!t) continue;
    const c = row._count.status;
    t.total += c;
    if (REACHED.includes(row.status)) t.reached += c;
    if (row.status === 'FAILED') t.failed += c;
  }
  for (const row of recent) if (out[row.templateName]) out[row.templateName].sends7d = row._count.templateName;
  for (const row of lastSends) if (out[row.templateName]) out[row.templateName].lastSentAt = row.sentAt;
  for (const t of Object.values(out)) {
    t.deliveryPct = t.total ? Math.round((t.reached / t.total) * 1000) / 10 : null;
  }
  return out;
}

async function listMessages(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.templateName) where.templateName = filters.templateName;
  if (filters.leadId) where.leadId = filters.leadId;
  if (filters.from || filters.to) {
    where.sentAt = {};
    if (filters.from) where.sentAt.gte = new Date(filters.from);
    if (filters.to)   where.sentAt.lte = new Date(filters.to);
  }

  const [data, total] = await Promise.all([
    prisma.watiMessageLog.findMany({ where, skip, take: limit, orderBy: { sentAt: 'desc' } }),
    prisma.watiMessageLog.count({ where }),
  ]);

  // Masked even for admin — a delivery log is an operational view, not a
  // reason to dump every buyer's number into one exportable list.
  return { data: data.map((m) => ({ ...m, recipientPhone: maskPhone(m.recipientPhone) })), total };
}

// 12.6 — header stats: spend MTD, per-message average, overall delivery rate.
async function getWatiStats() {
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [mtd, allTime, byStatus] = await Promise.all([
    prisma.watiMessageLog.aggregate({
      where: { sentAt: { gte: startOfMonth } },
      _sum: { costPaise: true }, _count: { _all: true },
    }),
    prisma.watiMessageLog.aggregate({ _sum: { costPaise: true }, _count: { _all: true } }),
    prisma.watiMessageLog.groupBy({ by: ['status'], _count: { status: true } }),
  ]);

  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count.status]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const reached = REACHED.reduce((sum, s) => sum + (counts[s] || 0), 0);
  const spendMtdPaise = mtd._sum.costPaise || 0;

  return {
    messagesMtd: mtd._count._all,
    spendMtdPaise,
    // null rather than 0 when nothing is priced yet — costPaise is only
    // populated if the account reports per-message cost, and a 0 average
    // would read as "free" instead of "unknown".
    avgCostPaise: mtd._count._all && spendMtdPaise ? Math.round(spendMtdPaise / mtd._count._all) : null,
    messagesAllTime: allTime._count._all,
    spendAllTimePaise: allTime._sum.costPaise || 0,
    byStatus: counts,
    deliveryPct: total ? Math.round((reached / total) * 1000) / 10 : null,
    accountConnected: !!(process.env.WATI_API_ENDPOINT && process.env.WATI_ACCESS_TOKEN),
  };
}

// Called by the WATI webhook as delivery events arrive. Matched on WATI's
// message id when present, otherwise the most recent send to that number —
// WATI doesn't always echo the id back on status callbacks.
async function recordDeliveryEvent({ messageId, phone, status, failureReason }) {
  const STATUS_FIELD = { DELIVERED: 'deliveredAt', READ: 'readAt', RESPONDED: 'respondedAt' };

  let row = null;
  if (messageId) row = await prisma.watiMessageLog.findFirst({ where: { messageId } });
  if (!row && phone) {
    row = await prisma.watiMessageLog.findFirst({
      where: { recipientPhone: phone },
      orderBy: { sentAt: 'desc' },
    });
  }
  if (!row) return null;

  // Never walk a message backwards: a late DELIVERED callback must not
  // overwrite a READ/RESPONDED that already landed.
  const RANK = { SENT: 0, DELIVERED: 1, READ: 2, RESPONDED: 3, FAILED: 1 };
  if ((RANK[status] ?? 0) < (RANK[row.status] ?? 0)) return row;

  return prisma.watiMessageLog.update({
    where: { id: row.id },
    data: {
      status,
      ...(STATUS_FIELD[status] ? { [STATUS_FIELD[status]]: new Date() } : {}),
      ...(failureReason && { failureReason }),
    },
  });
}

module.exports = {
  listTemplates, getTemplateById, createTemplate, updateTemplate, deleteTemplate,
  submitTemplate, syncTemplateStatus, testSend,
  listMessages, getWatiStats, recordDeliveryEvent, deliveryStatsFor,
};
