const ExcelJS = require('exceljs');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const f = require('../../lib/leadSales');

const EXPORT_MAX = 5000;
const who = (user) => user.name || user.email || 'Staff';

const audit = (user, action, targetId, extra, ip) =>
  createAuditLog({ adminId: user.id, action, targetType: 'Lead', targetId: String(targetId), ...extra, ipAddress: ip })
    .catch((err) => logger.warn('[leadSales] audit failed', { action, error: err.message }));

/** The lead, or a 404 if it does not exist or a BDE does not own it (a BDE is not told that other leads exist). */
async function loadLead(user, leadId) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  const scope = f.leadScope(user);
  if (!lead || (scope.ownerStaffId && lead.ownerStaffId !== scope.ownerStaffId)) throw new ApiError(404, 'Lead not found');
  return lead;
}

async function nameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name || u.email]));
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const view = (lead) => ({
  id: lead.id, salesStage: lead.salesStage || 'NEW', temperature: lead.temperature || null, ownerStaffId: lead.ownerStaffId || null,
  ownerAssignedAt: lead.ownerAssignedAt || null, nextFollowUpAt: lead.nextFollowUpAt || null, lastContactedAt: lead.lastContactedAt || null,
  qualifiedAt: lead.qualifiedAt || null, notQualifiedReason: lead.notQualifiedReason || null,
});

async function updateSales(user, leadId, body, ip) {
  const access = f.salesAccess(user);
  if (!access.canWork) throw new ApiError(403, 'You do not have access to lead qualification.');
  const lead = await loadLead(user, leadId);
  if (access.bde && !f.QUALIFICATION_STATUSES.includes(lead.status)) {
    throw new ApiError(409, 'This lead has been handed to a partner, so it can no longer be changed here.', { code: 'LEAD_HANDED_OVER' });
  }
  const { data, said } = f.planSalesChange(lead, body, access);
  if (data.ownerStaffId) {
    const staff = await prisma.user.findFirst({ where: { id: data.ownerStaffId, role: 'ADMIN' }, select: { id: true } });
    if (!staff) throw new ApiError(400, 'Choose a staff member to own this lead.', { code: 'OWNER_INVALID' });
  }
  if (!Object.keys(data).length) return view(lead);

  const updated = await prisma.lead.update({ where: { id: leadId }, data });
  const owners = await nameMap([data.ownerStaffId, lead.ownerStaffId]);
  const lines = said.map((s) => {
    if (typeof s === 'string') return s;
    if ('owner' in s) return `Owner: ${owners[lead.ownerStaffId] || 'nobody'} → ${s.owner ? owners[s.owner] || 'a staff member' : 'nobody'}`;
    return `Next follow-up: ${fmtDay(s.followUp)}`;
  });
  if (data.notQualifiedReason) lines.push(`Reason: ${data.notQualifiedReason}`);
  if (lines.length) await prisma.leadNote.create({ data: { leadId, authorId: user.id, authorName: who(user), kind: 'SYSTEM', text: lines.join('. ') } });
  await audit(user, 'LEAD_SALES_UPDATED', leadId, { metadata: { fields: Object.keys(data) } }, ip);
  return view(updated);
}

async function addNote(user, leadId, body, ip) {
  if (!f.salesAccess(user).canWork) throw new ApiError(403, 'You do not have access to lead notes.');
  const lead = await loadLead(user, leadId);
  const note = await prisma.leadNote.create({ data: { leadId, authorId: user.id, authorName: who(user), kind: body.kind, text: body.text } });

  const update = {};
  const stage = lead.salesStage || 'NEW';
  if (f.CONTACT_KINDS.includes(body.kind)) {
    update.lastContactedAt = new Date();
    update.contactAttempts = (lead.contactAttempts || 0) + 1;
    if (stage === 'NEW') update.salesStage = 'CONTACTED';
  }
  if (body.nextFollowUpAt !== undefined && !f.TERMINAL.includes(stage)) {
    update.nextFollowUpAt = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null;
    if (body.nextFollowUpAt) update.salesStage = 'FOLLOW_UP';
  }
  if (Object.keys(update).length) await prisma.lead.update({ where: { id: leadId }, data: update });
  await audit(user, 'LEAD_NOTE_ADDED', leadId, { metadata: { kind: body.kind } }, ip);
  return { note, lead: view({ ...lead, ...update }) };
}

async function listNotes(user, leadId) {
  if (!f.salesAccess(user).canWork) throw new ApiError(403, 'You do not have access to lead notes.');
  const lead = await loadLead(user, leadId);
  const notes = await prisma.leadNote.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 200 });
  // The single note box that existed before the history is kept and shown below the timeline.
  return { notes, legacyNote: lead.adminNotes || null, sales: view(lead) };
}

/** Counts for the top of the leads page and the "My follow-ups" view, for the leads this person may see. */
async function salesSummary(user, now = new Date()) {
  const access = f.salesAccess(user);
  if (!access.canWork) throw new ApiError(403, 'You do not have access to lead qualification.');
  const base = f.leadScope(user);
  const count = (extra) => prisma.lead.count({ where: { ...base, ...extra } });
  const mine = (q) => f.salesWhere(q, user.id, now);
  const [stages, temps, overdue, today, upcoming, unowned, total, needsDecision] = await Promise.all([
    Promise.all(f.STAGES.map((s) => count(mine({ salesStage: s })))),
    Promise.all(f.TEMPERATURES.map((t) => count(mine({ temperature: t })))),
    count(mine({ followUp: 'overdue' })), count(mine({ followUp: 'today' })), count(mine({ followUp: 'upcoming' })),
    access.manager ? count(mine({ owner: 'none' })) : Promise.resolve(null),
    count({}),
    count(mine({ decision: '1' })),
  ]);
  return {
    total, unowned, needsDecision,
    stages: Object.fromEntries(f.STAGES.map((s, i) => [s, stages[i]])),
    temperatures: Object.fromEntries(f.TEMPERATURES.map((t, i) => [t, temps[i]])),
    followUp: { overdue, today, upcoming },
  };
}

/** Staff who can own a lead: the BDEs, so a manager can pick one. */
async function owners(user) {
  if (!f.salesAccess(user).canWork) throw new ApiError(403, 'You do not have access to lead qualification.');
  const staff = await prisma.user.findMany({
    where: { role: 'ADMIN', deletedAt: { isSet: false }, OR: [{ adminPermissions: { has: 'SALES' } }, { staffRole: 'BDE' }] },
    select: { id: true, name: true, email: true, staffRole: true }, orderBy: { name: 'asc' }, take: 100,
  });
  return staff.map((s) => ({ id: s.id, name: s.name || s.email, staffRole: s.staffRole }));
}

/** The leads list filter shared by the page and the export. */
function listWhere(query, user) {
  const where = {};
  if (query.status) where.status = query.status;
  if (query.partnerId) where.assignedPartnerId = query.partnerId;
  if (query.search) where.OR = [
    { refCode: { contains: query.search, mode: 'insensitive' } },
    { buyerName: { contains: query.search, mode: 'insensitive' } },
    { buyerEmail: { contains: query.search, mode: 'insensitive' } },
  ];
  return { ...where, ...f.leadScope(user), ...f.salesWhere(query, user.id) };
}

const COLUMNS = [
  ['Reference', 18], ['Received', 14], ['Buyer', 24], ['Phone', 16], ['Email', 28], ['City', 14], ['Property or interest', 32], ['Budget', 16],
  ['Source', 12], ['Stage', 14], ['Temperature', 12], ['Owner', 20], ['Next follow-up', 16], ['Last contacted', 16], ['Qualified on', 14],
  ['Not qualified because', 28], ['Handed to partner', 22], ['Lead status', 18], ['Latest notes', 70],
];

/** An .xlsx of the leads matching the filters, for managers: notes and next action included. Capped, and recorded in the audit log. */
async function exportLeads(user, query, ip) {
  const where = listWhere(query, user);
  const total = await prisma.lead.count({ where });
  if (total > EXPORT_MAX) throw new ApiError(400, `That is ${total} leads. Narrow the filters to ${EXPORT_MAX} or fewer, then export again.`, { code: 'EXPORT_TOO_LARGE' });
  const leads = await prisma.lead.findMany({
    where, orderBy: { createdAt: 'desc' }, take: EXPORT_MAX,
    include: { property: { select: { title: true, city: true } }, assignedPartner: { select: { name: true } } },
  });
  const ids = leads.map((l) => l.id);
  const notes = ids.length ? await prisma.leadNote.findMany({ where: { leadId: { in: ids }, kind: { not: 'SYSTEM' } }, orderBy: { createdAt: 'desc' } }) : [];
  const latest = {};
  for (const n of notes) { (latest[n.leadId] = latest[n.leadId] || []); if (latest[n.leadId].length < 3) latest[n.leadId].push(n); }
  const owners = await nameMap(leads.map((l) => l.ownerStaffId));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Realtydoor'; wb.created = new Date();
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C2FEE' } };
  head.alignment = { vertical: 'middle' };
  const date = (d) => (d ? new Date(d) : null);
  for (const l of leads) {
    const row = ws.addRow([
      l.refCode || l.id, date(l.createdAt), l.buyerName, l.buyerPhone, l.buyerEmail, l.city || l.property?.city || '', l.property?.title || l.propertyInterest || '',
      l.budget || '', l.source, l.salesStage ? f.STAGE_LABEL[l.salesStage] : 'New', l.temperature ? f.TEMP_LABEL[l.temperature] : '', owners[l.ownerStaffId] || '',
      date(l.nextFollowUpAt), date(l.lastContactedAt), date(l.qualifiedAt), l.notQualifiedReason || '', l.assignedPartner?.name || '', l.status,
      (latest[l.id] || []).map((n) => `${fmtDay(n.createdAt)} ${n.authorName} (${n.kind.toLowerCase()}): ${n.text}`).join('\n') || (l.adminNotes || ''),
    ]);
    // Text cells are never read as formulas by Excel, but keep every value a plain string or date, never a formula object.
    [2, 13, 14, 15].forEach((c) => { if (row.getCell(c).value) row.getCell(c).numFmt = 'dd-mmm-yyyy'; });
    row.getCell(19).alignment = { wrapText: true, vertical: 'top' };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  const buffer = await wb.xlsx.writeBuffer();
  await audit(user, 'LEADS_EXPORTED', 'export', { metadata: { rows: leads.length, filters: Object.keys(query || {}).filter((k) => query[k]) } }, ip);
  return { buffer, rows: leads.length };
}

module.exports = { updateSales, addNote, listNotes, salesSummary, owners, exportLeads, listWhere, loadLead, nameMap, EXPORT_MAX };
