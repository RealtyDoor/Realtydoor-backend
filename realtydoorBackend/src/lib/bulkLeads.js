'use strict';

// Bulk lead lists (the old Buildesk CRM first) -> our lead format. Pure logic only (no database), so it is tested without one;
// scripts/importBulkLeads.js does the reading and writing. Every lead is written into the qualification pool (lib/poolLeads.js) and sorted
// into group A (strong signals: promote after a manager's review), B (call first) or C (archive). Nothing here sends anything.
//
// Rules that matter (see the plan, "Break-test"): createdAt is NOT back-dated (the old date goes in originalLeadAt); nothing copied that would
// start a live clock (campaign, contactAttempts, partner links, consent).
const { normalizePhone } = require('./phoneUtils');

const BUILDESK = { id: 'buildesk', prefix: 'buildesk' };

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? '').trim();
  return String(v).trim();
};
const num = (v) => { const n = Number(String(text(v)).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };

/** "23/11/2026 14:05" (day first, India time) -> Date. Also accepts a Date. Returns null when it is not a date. */
function parseIndiaDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = text(v);
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
  const day = Number(d), month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(Number(y), month - 1, day, Number(h), Number(mi), Number(se)) - 330 * 60000); // IST = UTC+5:30
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Country code + number -> E.164, or null when it cannot be a real mobile number. */
function parsePhone(cc, mobile) {
  const digits = text(mobile).replace(/[^0-9]/g, '');
  if (!digits) return null;
  const code = text(cc).replace(/[^0-9]/g, '');
  return normalizePhone(code ? `+${code}${digits}` : digits) || normalizePhone(digits);
}

// The old CRM's "Source". IMS = calls straight from hoardings (owner, 24 Nov 2026). IMS-ADS is not known yet, so it stays OTHER (raw value kept).
function mapSource(source, subSource) {
  const s = text(source).toUpperCase();
  const sub = text(subSource).toUpperCase();
  const MAP = { IMS: 'HOARDING', FB: 'FACEBOOK', IG: 'INSTAGRAM', WEBSITE: 'WEBSITE', WHATSAPP: 'WHATSAPP', 'WALK-IN': 'WALK_IN', 'WALK IN': 'WALK_IN', IVR: 'PHONE', CALLTRACK: 'PHONE' };
  return { source: MAP[s] || 'OTHER', sourceDetail: [text(source), text(subSource)].filter(Boolean).join(' / ') || null, known: !!MAP[s] || !s, sub };
}

const NEGATIVE = /not\s*interested|no\s*interest|wrong\s*number|invalid\s*number|don'?t\s*call|do\s*not\s*call|stop\s*calling|dnd\b/i;
/** The latest remarks say the buyer is not interested or the number is wrong. */
const saysNotInterested = (...texts) => texts.some((t) => NEGATIVE.test(text(t)));

/**
 * Old stage + reason + category -> our fields.
 * dropped: kept and searchable, but never in a queue (inactive, spam, irrelevant).
 */
function mapStage(stage, reason, category) {
  const st = text(stage).toUpperCase();
  const rs = text(reason).toLowerCase();
  const cat = text(category).toUpperCase();
  let temperature = ['HOT', 'WARM', 'COLD'].includes(cat) ? cat : null;
  const out = { salesStage: 'NEW', temperature, dropped: false, dropReason: null, droppedText: null, notQualifiedReason: null, note: null };
  if (['ON FOLLOWUP', 'COLD', 'WARM', 'HOT'].includes(st)) {
    out.salesStage = 'CONTACTED';
    if (['COLD', 'WARM', 'HOT'].includes(st)) out.temperature = st;
  }
  if (st === 'NEGOTIATION') Object.assign(out, { salesStage: 'QUALIFIED', temperature: 'HOT', note: 'Was in negotiation in the old CRM.' });
  if (st === 'BOOKED') Object.assign(out, { salesStage: 'QUALIFIED', temperature: 'HOT', note: 'Was marked booked in the old CRM (not a closed deal here: no payment exists).' });
  if (st === 'INACTIVE') Object.assign(out, { salesStage: 'NOT_QUALIFIED', dropped: true, dropReason: 'OTHER', droppedText: 'Inactive in the old CRM', notQualifiedReason: 'Inactive in the old CRM' });
  if (rs.startsWith('spam')) Object.assign(out, { salesStage: 'NOT_QUALIFIED', dropped: true, dropReason: 'OTHER', droppedText: 'Spam in the old CRM', notQualifiedReason: 'Spam' });
  else if (rs.startsWith('irrelevant')) Object.assign(out, { salesStage: 'NOT_QUALIFIED', dropped: true, dropReason: 'NOT_INTERESTED', droppedText: 'Irrelevant in the old CRM', notQualifiedReason: 'Irrelevant' });
  else if (rs.startsWith('location')) Object.assign(out, { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Location issue (old CRM)' });
  else if (rs.startsWith('budget')) Object.assign(out, { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Budget issue (old CRM)' });
  return out;
}

const tidyProjects = (v) => text(v).split(/[,;]+/).map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean).map((p) => p.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())).join(', ');

/** Turns one spreadsheet row (header name -> value) into a mapped lead, before sorting into groups. */
function mapBuildeskRow(row, preset = BUILDESK) {
  const r = (k) => text(row[k]);
  const phone = parsePhone(row.Mobile_CC, row.Mobile);
  const stage = mapStage(row.Stage, row.Stage_Reason, row.Category);
  const src = mapSource(row.Source, row.SubSource);
  const originalLeadAt = parseIndiaDate(row.Lead_Date);
  const minB = num(row.Min_Budget), maxB = num(row.Max_Budget);
  const budget = minB || maxB ? (minB && maxB && minB !== maxB ? `${minB} - ${maxB}` : String(maxB || minB)) : null;
  const executive = r('Executive');
  const siteVisits = num(row.Conducted_SiteVisit_Count);
  const lastActivity = r('Last_Activity');
  const remark = r('Remark');
  const returning = r('Returning').toLowerCase() === 'yes';
  const answers = {};
  // EVERY column of the old record is kept (nothing is left behind): empty ones are skipped, zero counts are kept because "0 follow-ups" is information.
  const keep = (k, v) => { if (v !== '' && v != null) answers[`${preset.prefix}_${k}`] = v; };
  const date = (v) => { const d = parseIndiaDate(v); return d ? d.toISOString() : ''; };
  keep('ref_no', r('Ref_No')); keep('lead_number', r('Lead_Number')); keep('executive', executive);
  keep('stage', r('Stage')); keep('stage_reason', r('Stage_Reason')); keep('category', r('Category'));
  keep('first_stage', r('First_Stage')); keep('first_stage_updated', date(row.First_Stage_Updated_Date));
  keep('returned_date', date(row.Returned_Date)); keep('assigned_date', date(row.Assigned_Date));
  keep('secondary_number', [r('Secondary_No_CC'), r('Secondary_No')].filter(Boolean).join(' '));
  keep('co_owners', r('Co_Owners')); keep('sourcing_manager', r('Sourcing_Manager')); keep('presales', r('PresalesUserName')); keep('tags', r('Tags'));
  keep('campaign', r('Campaign_Name')); keep('campaign_channel', r('Campaign_Channel_Name')); keep('ad', r('AdName'));
  keep('location', [r('Location'), r('SubLocation')].filter(Boolean).join(', '));
  keep('channel_partner', r('Channel_Partner_Name')); keep('channel_partner_mobile', r('CP_Mobile')); keep('cp_tag_days_left', r('CP_Tag_Remaining_Days'));
  keep('last_assigned_agent', r('Last_Assigned_Sales_Agent')); keep('last_assigned_agent_stage', r('Last_Assigned_Sales_Agent_Stage')); keep('last_assigned_date', date(row.Last_Assigned_Date));
  keep('last_activity', lastActivity); keep('last_activity_date', date(row.Last_Activity_Date)); keep('last_contacted', date(row.Last_Contacted_Date));
  keep('first_activity_date', date(row.First_Activity_Date));
  keep('income', r('Income')); keep('employment', r('EmploymentType')); keep('designation', r('Designation')); keep('company', r('CompanyName')); keep('company_address', r('CompanyAddress'));
  keep('followups_done', r('Completed_Task_Count') === '' ? '' : num(row.Completed_Task_Count));
  keep('followups_pending', r('Pending_Task_Count') === '' ? '' : num(row.Pending_Task_Count));
  keep('followups_after_return', r('Task_Count_After_Returned') === '' ? '' : num(row.Task_Count_After_Returned));
  keep('site_visits_done', r('Conducted_SiteVisit_Count') === '' ? '' : siteVisits);
  keep('site_visits_pending', r('Pending_SiteVisit_Count') === '' ? '' : num(row.Pending_SiteVisit_Count));
  keep('returning_count', r('Returning_Count') === '' ? '' : num(row.Returning_Count));
  keep('budget_min', minB || ''); keep('budget_max', maxB || '');
  for (const [k, col] of [['utm_campaign', 'Utm_Campaign'], ['utm_medium', 'Utm_Medium'], ['utm_source', 'Utm_Source'], ['utm_term', 'Utm_Term'], ['utm_content', 'Utm_Content'], ['gclid', 'GCLId'], ['fbid', 'FbId'], ['ethnicity', 'Ethnicity']]) keep(k, r(col));
  keep('remark', remark);
  if (returning) answers[`${preset.prefix}_returning`] = 'Yes';
  if (!phone) answers[`${preset.prefix}_raw_phone`] = `${r('Mobile_CC')} ${r('Mobile')}`.trim();
  if (executive) answers.legacy_executive = executive;

  const notes = [];
  const by = `${executive || 'Old CRM'} (old CRM)`;
  const at = (v) => parseIndiaDate(v) || originalLeadAt;
  if (remark) notes.push({ authorName: by, kind: 'NOTE', text: `Remark: ${remark}`, createdAt: originalLeadAt });
  if (r('First_Activity_Remark')) notes.push({ authorName: by, kind: 'NOTE', text: `First activity: ${r('First_Activity_Remark')}`, createdAt: at(row.First_Activity_Date) });
  if (lastActivity) notes.push({ authorName: by, kind: 'NOTE', text: `Last activity: ${lastActivity}`, createdAt: at(row.Last_Activity_Date) });
  if (siteVisits > 0) notes.push({ authorName: by, kind: 'MEETING', text: `${siteVisits} site visit${siteVisits > 1 ? 's' : ''} done in the old CRM.`, createdAt: at(row.Last_Activity_Date) });
  if (stage.note) notes.push({ authorName: 'Import', kind: 'SYSTEM', text: stage.note, createdAt: originalLeadAt });

  return {
    key: `${preset.id}:${r('Ref_No') || r('Lead_Number')}`,
    phone, originalLeadAt, stage, src, returning, siteVisits, remarks: [remark, lastActivity], executive,
    lastContactedAt: parseIndiaDate(row.Last_Contacted_Date),
    notes,
    data: {
      buyerName: r('Lead_Name') || 'Unknown', buyerEmail: r('Email').toLowerCase(), buyerPhone: phone || '',
      buyerMessage: null, propertyInterest: tidyProjects(row.Project_Names) || null, budget,
      source: src.source, sourceDetail: src.sourceDetail, status: 'UNASSIGNED',
      salesStage: stage.salesStage, temperature: stage.temperature, notQualifiedReason: stage.notQualifiedReason,
      lastContactedAt: parseIndiaDate(row.Last_Contacted_Date), originalLeadAt, intakeAnswers: answers,
    },
  };
}

// A plain contact list (Name, Contact Number, Email Id, City, Location): an area list such as "Electronic City" or "Sarjapur Road". Nothing is known
// about interest, so every valid, new number is "call first". list = { id, label, fileDate }.
const tidyName = (v) => text(v).toLowerCase().replace(/\s+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
const tidyCity = (v) => (/^(bangalore|banglore|bengaluru|bengalore)$/i.test(text(v)) ? 'Bengaluru' : tidyName(v));

function mapListRow(row, list) {
  const phone = parsePhone('', row['Contact Number']);
  const location = tidyName(row.Location);
  const city = tidyCity(row.City);
  const listDate = list.fileDate ? new Date(`${list.fileDate}T00:00:00+05:30`) : null;
  const answers = { list_name: list.label, list_name_as_written: text(row.Name) };
  if (location) answers.list_location = location;
  if (text(row.City)) answers.list_city_as_written = text(row.City);
  if (!phone) answers.list_raw_phone = text(row['Contact Number']);
  return {
    key: `${list.id}:${phone || 'row-' + text(row['Contact Number'])}`,
    phone, originalLeadAt: listDate, stage: { salesStage: 'NEW', temperature: null, dropped: false, dropReason: null, droppedText: null, notQualifiedReason: null, note: null },
    src: { source: 'OTHER', sourceDetail: list.label, known: true }, returning: false, siteVisits: 0, remarks: [], executive: '', lastContactedAt: null, notes: [],
    data: {
      buyerName: tidyName(row.Name) || 'Unknown', buyerEmail: text(row['Email Id']).toLowerCase(), buyerPhone: phone || '', buyerMessage: null,
      propertyInterest: location || null, city: city || null, budget: null, source: 'OTHER', sourceDetail: list.label, status: 'UNASSIGNED', salesStage: 'NEW', temperature: null,
      notQualifiedReason: null, lastContactedAt: null, originalLeadAt: listDate, intakeAnswers: answers,
    },
  };
}
const LIST_PRESET = (list) => ({ id: list.id, prefix: 'list', mapRow: (row) => mapListRow(row, list) });

/**
 * Sorts a mapped lead into group A, B or C and says why. `ctx.doNotContact` is a Set of phones that opted out; `ctx.laterSamePhone` is
 * true when a newer row of the same phone exists (this one is then an old duplicate).
 */
function sortIntoGroup(m, ctx = {}) {
  if (!m.phone) return { group: 'C', reason: 'Invalid or missing phone number', drop: { code: 'INVALID_NUMBER', text: 'Invalid or missing phone number' } };
  if (ctx.doNotContact && ctx.doNotContact.has(m.phone)) return { group: 'C', reason: 'Asked not to be contacted' };
  if (ctx.laterSamePhone) return { group: 'C', reason: 'Older duplicate of the same phone number', drop: { code: 'DUPLICATE', text: 'Older duplicate of the same phone number' } };
  if (ctx.alreadyKnown) return { group: 'C', reason: 'Already a lead in our CRM (kept, linked to the earlier one)' };
  if (m.stage.dropped) return { group: 'C', reason: m.stage.droppedText, drop: { code: m.stage.dropReason, text: m.stage.droppedText } };
  if (m.stage.notQualifiedReason) return { group: 'C', reason: m.stage.notQualifiedReason };
  if (saysNotInterested(...m.remarks)) return { group: 'C', reason: 'Latest remarks say not interested or wrong number' };
  const signals = [];
  if (m.stage.temperature === 'HOT') signals.push('hot');
  if (m.stage.salesStage === 'QUALIFIED') signals.push('negotiation or booked');
  if (m.returning) signals.push('repeat enquiry');
  if (m.siteVisits > 0) signals.push('site visit done');
  if (signals.length) return { group: 'A', reason: `Strong signal: ${signals.join(', ')}` };
  return { group: 'B', reason: m.data.intakeAnswers && m.data.intakeAnswers.list_name ? 'From a contact list: call first' : 'Call first' };
}

/**
 * Plans a whole file. rows = array of header->value objects. existingKeys = keys already imported (skipped, so a second run writes nothing).
 * Returns { items, skipped, counts }.
 */
function planBulk(rows, { preset = BUILDESK, existingKeys = new Set(), doNotContact = new Set(), knownPhones = new Set(), batch } = {}) {
  const mapped = rows.map((r) => (preset.mapRow ? preset.mapRow(r) : mapBuildeskRow(r, preset)));
  // The newest row of a phone is the callable one; older rows of the same phone are kept but archived.
  const newest = new Map();
  for (const m of mapped) {
    if (!m.phone) continue;
    const cur = newest.get(m.phone);
    if (!cur || (m.originalLeadAt || 0) > (cur.originalLeadAt || 0)) newest.set(m.phone, m);
  }
  const items = [], skipped = [];
  const counts = { A: 0, B: 0, C: 0, byReason: {}, bySource: {}, byStage: {}, total: 0 };
  const seenKeys = new Set();
  for (const m of mapped) {
    if (existingKeys.has(m.key) || seenKeys.has(m.key)) { skipped.push({ key: m.key, reason: existingKeys.has(m.key) ? 'already imported' : 'same reference twice in the file' }); continue; }
    seenKeys.add(m.key);
    const sorted = sortIntoGroup(m, { doNotContact, laterSamePhone: !!m.phone && newest.get(m.phone) !== m, alreadyKnown: !!m.phone && knownPhones.has(m.phone) });
    counts[sorted.group] += 1; counts.total += 1;
    counts.byReason[sorted.reason] = (counts.byReason[sorted.reason] || 0) + 1;
    counts.bySource[m.src.source] = (counts.bySource[m.src.source] || 0) + 1;
    counts.byStage[m.stage.salesStage] = (counts.byStage[m.stage.salesStage] || 0) + 1;
    items.push({ ...m, ...sorted, batch });
  }
  return { items, skipped, counts };
}

/** The fields to write for one planned item (Prisma lead data). refCode and createdAt are added by the script. */
function toLeadData(item, batch) {
  const d = { ...item.data, poolBatch: batch, poolGroup: item.group, poolGroupReason: item.reason };
  if (item.drop || item.stage.dropped) {
    const drop = item.drop || { code: item.stage.dropReason, text: item.stage.droppedText };
    Object.assign(d, { status: 'DROPPED', droppedReasonCode: drop.code, droppedReason: drop.text, droppedAt: item.originalLeadAt || new Date() });
  }
  if (item.group === 'C' && !d.notQualifiedReason) d.notQualifiedReason = item.reason;
  return d;
}

module.exports = { LIST_PRESET, mapListRow, BUILDESK, parseIndiaDate, parsePhone, mapSource, mapStage, saysNotInterested, mapBuildeskRow, sortIntoGroup, planBulk, toLeadData, text };
