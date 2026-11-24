// Reception desk (23 Nov 2026). A receptionist (staff role RECEPTION, an ADMIN-role account locked to /api/reception by
// lib/staffLockdown.js) records each site visit: the buyer, when, who hosted them, a photo, and the buyer's visit code when they have it.
// A correct code completes the visit through the broker's own path (leads.service completeVisitWithCode), so every guard and the
// 3-try lock apply. No code, or a walk-in, is kept as an unverified record that changes nothing on the lead.
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const { notifyAdmins } = require('../../lib/notifications');
const { istDayRange } = require('../../lib/leadSales');

const OPEN = { notIn: ['CLOSED', 'DROPPED'] };
const LATE_ENTRY_MS = 48 * 60 * 60 * 1000; // a visit can be recorded up to two days late, never in the future
const IST_MS = 5.5 * 60 * 60 * 1000;

const who = (u) => u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || 'Reception';
const partnerName = (p) => (p ? p.companyName || p.name || null : null);
// Reception sees only the last 4 digits: enough to tell two buyers apart, not enough to call them.
const last4 = (phone) => (phone ? `•••• ${String(phone).replace(/\D/g, '').slice(-4)}` : null);

const LEAD_SELECT = {
  id: true, refCode: true, buyerName: true, buyerPhone: true, status: true, siteVisitScheduledAt: true, otpLockedUntil: true,
  assignedPartnerId: true, propertyInterest: true, doNotContactAt: true,
  property: { select: { title: true } },
  assignedPartner: { select: { name: true, companyName: true } },
};

function cardFor(lead) {
  return {
    id: lead.id,
    refCode: lead.refCode,
    buyerName: lead.buyerName,
    phoneHint: last4(lead.buyerPhone),
    property: lead.property?.title || lead.propertyInterest || null,
    visitAt: lead.siteVisitScheduledAt || null,
    status: lead.status,
    broker: partnerName(lead.assignedPartner),
    codeLocked: !!(lead.otpLockedUntil && new Date(lead.otpLockedUntil) > new Date()),
  };
}

/** Booked visits that match a ref code, a name, or the last digits of the phone. Never returns the phone or the code. */
async function searchLeads(q) {
  const text = q.trim();
  const digits = text.replace(/\D/g, '');
  const or = [{ buyerName: { contains: text, mode: 'insensitive' } }];
  if (/^RD-?L/i.test(text) || /^\d{1,6}$/.test(digits)) or.push({ refCode: { contains: text.toUpperCase() } });
  if (digits.length >= 4) or.push({ buyerPhone: { endsWith: digits.slice(-10) } });
  const leads = await prisma.lead.findMany({
    where: { status: 'SITE_VISIT_SCHEDULED', OR: or },
    select: LEAD_SELECT,
    orderBy: { siteVisitScheduledAt: 'asc' },
    take: 20,
  });
  return leads.filter((l) => !l.doNotContactAt).map(cardFor);
}

// A walk-in buyer: reuse their open lead if there is one, otherwise log a new WALK_IN lead the way admin does (no partner; the admin
// team assigns it under the usual ownership rules).
async function leadForWalkIn(data, staff, ip) {
  const open = await prisma.lead.findFirst({
    where: { buyerPhone: data.buyerPhone, status: OPEN },
    orderBy: { createdAt: 'desc' },
    select: LEAD_SELECT,
  });
  if (open) return { lead: open, created: false };
  const { createLead } = require('../admin/admin.service');
  const made = await createLead({
    buyerName: data.buyerName,
    buyerPhone: data.buyerPhone,
    source: 'WALK_IN',
    propertyInterest: data.interest || 'Walk-in at reception',
    city: 'Bengaluru',
    note: data.note,
  }, staff.id, ip);
  const lead = await prisma.lead.findUnique({ where: { id: made.id }, select: LEAD_SELECT });
  return { lead, created: true };
}

function visitTime(visitedAt, now = Date.now()) {
  if (!visitedAt) return new Date(now);
  const t = new Date(visitedAt).getTime();
  if (t > now + 5 * 60 * 1000) throw new ApiError(400, 'The visit time cannot be in the future.', { code: 'VISIT_IN_FUTURE' });
  if (t < now - LATE_ENTRY_MS) throw new ApiError(400, 'A visit can be recorded up to two days late. Ask an admin for anything older.', { code: 'VISIT_TOO_OLD' });
  return new Date(t);
}

/** Record one visit. `photoUrls` are the uploaded photos (at least one). Returns the saved record and whether the visit is now done. */
async function recordVisit(staff, data, photoUrls, ip) {
  if (!photoUrls?.length) throw new ApiError(400, 'Add a photo of the visit.', { code: 'PHOTO_REQUIRED' });
  const visitedAt = visitTime(data.visitedAt);

  let lead;
  let walkInCreated = false;
  if (data.walkIn) {
    ({ lead, created: walkInCreated } = await leadForWalkIn(data, staff, ip));
  } else {
    lead = await prisma.lead.findUnique({ where: { id: data.leadId }, select: LEAD_SELECT });
    if (!lead) throw new ApiError(404, 'Buyer not found');
  }
  if (data.hostedByType === 'ASSIGNED_PARTNER' && !lead.assignedPartnerId) {
    throw new ApiError(400, 'No broker is assigned to this buyer yet. Choose "Someone else" and type who hosted.', { code: 'NO_ASSIGNED_BROKER' });
  }

  // The code check marks the visit done (or throws: wrong code, locked, too early, expired, not open). Nothing is saved on a failure.
  let codeVerified = false;
  if (data.code) {
    const leads = require('../leads/leads.service');
    const full = await prisma.lead.findUnique({ where: { id: lead.id } });
    await leads.completeVisitWithCode(full, data.code, { ip, by: `reception (${who(staff)})`, actor: { adminId: staff.id, role: 'ADMIN' } });
    codeVerified = true;
  }

  const record = await prisma.receptionVisit.create({
    data: {
      leadId: lead.id,
      leadRef: lead.refCode || null,
      buyerName: lead.buyerName,
      propertyTitle: lead.property?.title || lead.propertyInterest || null,
      assignedPartnerId: lead.assignedPartnerId || null,
      assignedPartnerName: partnerName(lead.assignedPartner),
      recordedByStaffId: staff.id,
      recordedByName: who(staff),
      visitedAt,
      codeVerified,
      walkIn: !!data.walkIn,
      hostedByType: data.hostedByType,
      hostedByName: data.hostedByType === 'OTHER_PERSON' ? data.hostedByName : partnerName(lead.assignedPartner),
      hostedByPhone: data.hostedByType === 'OTHER_PERSON' ? data.hostedByPhone || null : null,
      photoUrls,
      photoConsentAt: new Date(),
      note: data.note || null,
      ipAddress: ip || null,
    },
  });

  const hostText = data.hostedByType === 'OTHER_PERSON' ? `${data.hostedByName} (not the assigned broker)` : partnerName(lead.assignedPartner) || 'the assigned broker';
  const state = codeVerified ? 'visit code verified, visit marked done' : data.walkIn ? 'walk-in, no code' : 'no code, not verified';
  await prisma.leadNote.create({
    data: { leadId: lead.id, authorId: staff.id, authorName: who(staff), kind: 'SYSTEM', text: `Reception recorded a site visit (${state}). Hosted by ${hostText}.${data.note ? ` Note: ${data.note}` : ''}` },
  }).catch(() => null);
  await createAuditLog({
    adminId: staff.id, actorRole: 'ADMIN', action: 'VISIT_RECEPTION_LOGGED', targetType: 'Lead', targetId: lead.id,
    after: { receptionVisitId: record.id, codeVerified, walkIn: !!data.walkIn, walkInLeadCreated: walkInCreated, hostedByType: data.hostedByType, visitedAt },
    ipAddress: ip || null,
  }).catch(() => null);

  // Admins hear about anything they may need to act on: someone other than the assigned broker hosted, an unverified visit, a walk-in.
  if (data.hostedByType === 'OTHER_PERSON' || !codeVerified) {
    const why = data.walkIn ? (walkInCreated ? 'Walk-in buyer, new lead created' : 'Walk-in buyer with an open lead')
      : !codeVerified ? 'Visit recorded without the code' : 'Visit hosted by someone other than the assigned broker';
    await notifyAdmins({
      title: 'Reception: check this visit',
      message: `${lead.refCode || 'A lead'} · ${lead.buyerName}: ${why}. Hosted by ${hostText}. Recorded by ${who(staff)}.`,
      type: 'VISIT_LOGGED',
      linkUrl: `/admin/reception-visits?leadId=${lead.id}`,
    }).catch(() => null);
  }

  return { visit: record, codeVerified, walkInLeadCreated: walkInCreated, leadRef: lead.refCode || null };
}

function dayRange(day) {
  if (!day) return istDayRange();
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - IST_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The signed-in receptionist's own entries for a day (IST), newest first. */
async function myVisits(staffId, day) {
  const { start, end } = dayRange(day);
  return prisma.receptionVisit.findMany({
    where: { recordedByStaffId: staffId, visitedAt: { gte: start, lt: end } },
    orderBy: { visitedAt: 'desc' },
    take: 200,
  });
}

/** Admin list: every entry, newest first, with filters. */
async function adminList(f) {
  const where = {};
  if (f.from || f.to) {
    where.visitedAt = {};
    if (f.from) where.visitedAt.gte = dayRange(f.from).start;
    if (f.to) where.visitedAt.lt = dayRange(f.to).end;
  }
  if (f.staffId) where.recordedByStaffId = f.staffId;
  if (f.partnerId) where.assignedPartnerId = f.partnerId;
  if (f.leadId) where.leadId = f.leadId;
  if (f.verified) where.codeVerified = f.verified === 'yes';
  const [items, total] = await Promise.all([
    prisma.receptionVisit.findMany({ where, orderBy: { visitedAt: 'desc' }, skip: (f.page - 1) * f.limit, take: f.limit }),
    prisma.receptionVisit.count({ where }),
  ]);
  return { data: items, pagination: { total, page: f.page, limit: f.limit, totalPages: Math.ceil(total / f.limit), hasNext: f.page * f.limit < total, hasPrev: f.page > 1 } };
}

module.exports = { searchLeads, recordVisit, myVisits, adminList, cardFor, visitTime, last4 };
