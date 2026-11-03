const ApiError = require('../utils/ApiError');

// Pure rules for the sales (BDE) layer on a lead: who may see and change what, how the follow-up buckets are cut, and what a
// stage change must carry. No database in here, so every rule can be tested on its own.

const STAGES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'QUALIFIED', 'NOT_QUALIFIED'];
const TERMINAL = ['QUALIFIED', 'NOT_QUALIFIED'];
const TEMPERATURES = ['HOT', 'WARM', 'COLD'];
const NOTE_KINDS = ['NOTE', 'CALL', 'WHATSAPP', 'MEETING'];
const CONTACT_KINDS = ['CALL', 'WHATSAPP', 'MEETING'];
const STAGE_LABEL = { NEW: 'New', CONTACTED: 'Contacted', FOLLOW_UP: 'Follow-up', QUALIFIED: 'Qualified', NOT_QUALIFIED: 'Not qualified' };
const TEMP_LABEL = { HOT: 'Hot', WARM: 'Warm', COLD: 'Cold' };
// Once a lead is given to a partner it has left qualification; a BDE can no longer change it (notes stay open to the team).
const QUALIFICATION_STATUSES = ['AWAITING_ADMIN', 'UNASSIGNED'];

/**
 * What this admin may do with leads. A manager (full access, SUPER_ADMIN, or the LEADS permission) sees every lead and can set
 * owners and export. A BDE (SALES without LEADS) sees and works only the leads they own. Anyone else keeps the access the leads
 * pages had before this layer existed (they are not part of the sales process).
 */
function salesAccess(user) {
  const held = user?.adminPermissions || [];
  const full = user?.staffRole == null || user?.staffRole === 'SUPER_ADMIN';
  const manager = full || held.includes('LEADS');
  const bde = !manager && held.includes('SALES');
  return { manager, bde, canWork: manager || bde };
}

/** The extra `where` that keeps a BDE to their own leads. Empty for everyone else. */
function leadScope(user) {
  return salesAccess(user).bde ? { ownerStaffId: user.id } : {};
}

// India has one time zone with no daylight saving, so a day is simply UTC+5:30. "Today" must mean the BDE's today.
const IST_MS = 330 * 60 * 1000;
function istDayRange(now = new Date()) {
  const local = new Date(now.getTime() + IST_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(startLocal - IST_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const newStage = [{ salesStage: { isSet: false } }, { salesStage: null }, { salesStage: 'NEW' }];

/** The `where` for the sales filters on the leads list (and the export). `me` is the id of the person asking. */
function salesWhere(query = {}, meId, now = new Date()) {
  const and = [];
  if (query.salesStage) {
    if (!STAGES.includes(query.salesStage)) throw new ApiError(400, 'Unknown stage');
    and.push(query.salesStage === 'NEW' ? { OR: newStage } : { salesStage: query.salesStage });
  }
  if (query.temperature) {
    if (query.temperature === 'NONE') and.push({ OR: [{ temperature: { isSet: false } }, { temperature: null }] });
    else if (TEMPERATURES.includes(query.temperature)) and.push({ temperature: query.temperature });
    else throw new ApiError(400, 'Unknown temperature');
  }
  if (query.owner) {
    if (query.owner === 'none') and.push({ OR: [{ ownerStaffId: { isSet: false } }, { ownerStaffId: null }] });
    else if (query.owner === 'me') and.push({ ownerStaffId: meId });
    else if (/^[a-f\d]{24}$/i.test(query.owner)) and.push({ ownerStaffId: query.owner });
    else throw new ApiError(400, 'Unknown owner');
  }
  if (query.followUp) {
    const { start, end } = istDayRange(now);
    // A lead that is already qualified or dropped from the pipeline has nothing left to chase.
    const open = { salesStage: { notIn: TERMINAL } };
    if (query.followUp === 'overdue') and.push({ nextFollowUpAt: { lt: start } }, open);
    else if (query.followUp === 'today') and.push({ nextFollowUpAt: { gte: start, lt: end } }, open);
    else if (query.followUp === 'upcoming') and.push({ nextFollowUpAt: { gte: end } }, open);
    else if (query.followUp === 'none') and.push({ OR: [{ nextFollowUpAt: { isSet: false } }, { nextFollowUpAt: null }] }, { OR: [...newStage, { salesStage: { in: ['CONTACTED', 'FOLLOW_UP'] } }] });
    else throw new ApiError(400, 'Unknown follow-up filter');
  }
  if (query.source) and.push({ source: query.source });
  const created = {};
  if (query.from && !Number.isNaN(Date.parse(query.from))) created.gte = new Date(query.from);
  if (query.to && !Number.isNaN(Date.parse(query.to))) created.lt = new Date(new Date(query.to).getTime() + 24 * 60 * 60 * 1000);
  if (Object.keys(created).length) and.push({ createdAt: created });
  return and.length ? { AND: and } : {};
}

/**
 * Checks a requested change and returns what to store, or throws. `lead` is the current row. Rules:
 *  - FOLLOW_UP needs a next follow-up date; NOT_QUALIFIED needs a reason; QUALIFIED and NOT_QUALIFIED end the chase, so the date is cleared.
 *  - moving back out of QUALIFIED / NOT_QUALIFIED reopens the lead and clears what those carried.
 *  - only a manager may change the owner.
 */
function planSalesChange(lead, body, access, now = new Date()) {
  const data = {};
  const said = [];
  const stage = body.salesStage ?? lead.salesStage ?? 'NEW';

  if (body.ownerStaffId !== undefined) {
    if (!access.manager) throw new ApiError(403, 'Only a manager can change who owns a lead.');
    const next = body.ownerStaffId || null;
    if ((lead.ownerStaffId || null) !== next) { data.ownerStaffId = next; data.ownerAssignedAt = next ? now : null; said.push({ owner: next }); }
  }
  if (body.temperature !== undefined) {
    if (body.temperature !== null && !TEMPERATURES.includes(body.temperature)) throw new ApiError(400, 'Unknown temperature');
    if ((lead.temperature || null) !== body.temperature) { data.temperature = body.temperature; said.push(`Temperature: ${TEMP_LABEL[lead.temperature] || 'not set'} → ${TEMP_LABEL[body.temperature] || 'not set'}`); }
  }
  if (body.salesStage !== undefined) {
    if (!STAGES.includes(body.salesStage)) throw new ApiError(400, 'Unknown stage');
    if ((lead.salesStage || 'NEW') !== body.salesStage) {
      data.salesStage = body.salesStage;
      said.push(`Stage: ${STAGE_LABEL[lead.salesStage || 'NEW']} → ${STAGE_LABEL[body.salesStage]}`);
      if (body.salesStage === 'QUALIFIED') { data.qualifiedAt = now; data.notQualifiedReason = null; }
      else if (body.salesStage === 'NOT_QUALIFIED') { data.qualifiedAt = null; }
      else { data.qualifiedAt = null; data.notQualifiedReason = null; }
    }
  }
  if (body.notQualifiedReason !== undefined && stage === 'NOT_QUALIFIED') data.notQualifiedReason = String(body.notQualifiedReason || '').trim() || null;
  if (stage === 'NOT_QUALIFIED' && !(data.notQualifiedReason ?? lead.notQualifiedReason)) {
    throw new ApiError(400, 'Say why this lead is not qualified.', { code: 'REASON_REQUIRED' });
  }
  if (body.nextFollowUpAt !== undefined) {
    if (body.nextFollowUpAt === null) data.nextFollowUpAt = null;
    else {
      const when = new Date(body.nextFollowUpAt);
      if (Number.isNaN(when.getTime())) throw new ApiError(400, 'That follow-up date is not valid.');
      data.nextFollowUpAt = when;
      said.push({ followUp: when });
    }
  }
  if (TERMINAL.includes(stage)) {
    if (lead.nextFollowUpAt || data.nextFollowUpAt) data.nextFollowUpAt = null;
  } else if (stage === 'FOLLOW_UP' && !(data.nextFollowUpAt ?? lead.nextFollowUpAt)) {
    throw new ApiError(400, 'Pick the date of the next follow-up.', { code: 'FOLLOW_UP_REQUIRED' });
  }
  return { data, said };
}

module.exports = {
  STAGES, TERMINAL, TEMPERATURES, NOTE_KINDS, CONTACT_KINDS, STAGE_LABEL, TEMP_LABEL, QUALIFICATION_STATUSES,
  salesAccess, leadScope, istDayRange, salesWhere, planSalesChange,
};
