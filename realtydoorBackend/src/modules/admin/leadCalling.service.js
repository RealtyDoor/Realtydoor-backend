'use strict';

// The calling list for the qualification pool (24 Nov 2026). A caller (BDE, or a manager) takes the next batch of pool leads, calls them
// one by one and taps what happened. Nothing here gives a lead to a partner: "interested" qualifies it, which releases it to Lead Dispatch
// (lib/leadSales.js planSalesChange), and a manager still dispatches it from there.
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const f = require('../../lib/leadSales');
const { inPool, isInPool } = require('../../lib/poolLeads');
const leadSales = require('../leadSales/leadSales.service');

const BATCH_SIZE = 50;
const TAKE_GROUPS = ['A', 'B'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FOLLOW_UP_DAYS = 60;

const OUTCOMES = ['NO_ANSWER', 'CALL_LATER', 'INTERESTED', 'HOT', 'NOT_INTERESTED', 'WRONG_NUMBER', 'DO_NOT_CALL'];
const ownerUnset = { OR: [{ ownerStaffId: { isSet: false } }, { ownerStaffId: null }] };
const who = (user) => user.name || user.email || 'Staff';
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

function requireCaller(user) {
  if (!f.salesAccess(user).canWork) throw new ApiError(403, 'You do not have access to the calling list.');
}

/** "Work waiting" for this person: leads never called, and follow-ups due by the end of today (India time). */
function workWaiting(userId, now) {
  const { end } = f.istDayRange(now);
  return {
    ...inPool(), ownerStaffId: userId, poolGroup: { in: TAKE_GROUPS },
    OR: [
      { salesStage: { isSet: false } }, { salesStage: null }, { salesStage: 'NEW' },
      { nextFollowUpAt: { lt: end }, salesStage: { notIn: f.TERMINAL } },
    ],
  };
}

/** Take the next batch of unowned pool leads to call, up to BATCH_SIZE of waiting work (so nobody hoards a whole list). */
async function takeNext(user, { group = 'B', count } = {}, ip, now = new Date()) {
  requireCaller(user);
  if (!TAKE_GROUPS.includes(group)) throw new ApiError(400, 'Take leads from Call first or Strong signals.');
  const want = Math.min(Math.max(parseInt(count, 10) || BATCH_SIZE, 1), BATCH_SIZE);
  const waiting = await prisma.lead.count({ where: workWaiting(user.id, now) });
  const room = Math.min(want, BATCH_SIZE - waiting);
  if (room <= 0) {
    throw new ApiError(409, `You already have ${waiting} leads waiting for a call. Call some of them first, then take more.`, { code: 'BATCH_FULL' });
  }
  const candidates = await prisma.lead.findMany({
    where: { ...inPool({ group }), AND: [ownerUnset, { OR: [{ doNotContactAt: { isSet: false } }, { doNotContactAt: null }] }], buyerPhone: { not: '' } },
    orderBy: [{ originalLeadAt: 'desc' }, { id: 'asc' }], take: room, select: { id: true },
  });
  if (!candidates.length) return { taken: 0, room, message: 'No leads are left to take in that group.' };
  const ids = candidates.map((c) => c.id);
  // The guard on "no owner yet" makes a race between two callers safe: each lead goes to only one of them.
  await prisma.lead.updateMany({ where: { id: { in: ids }, ...inPool(), AND: [ownerUnset] }, data: { ownerStaffId: user.id, ownerAssignedAt: now } });
  const mine = await prisma.lead.findMany({ where: { id: { in: ids }, ownerStaffId: user.id, ownerAssignedAt: now }, select: { id: true } });
  if (mine.length) {
    await prisma.leadNote.createMany({ data: mine.map((l) => ({ leadId: l.id, authorId: user.id, authorName: who(user), kind: 'SYSTEM', text: 'Taken from the qualification pool to call.' })) })
      .catch((err) => logger.warn('[leadCalling] notes failed', { error: err.message }));
  }
  createAuditLog({ adminId: user.id, action: 'LEAD_POOL_TAKE', targetType: 'Lead', targetId: ids[0], metadata: { group, taken: mine.length }, ipAddress: ip }).catch(() => null);
  return { taken: mine.length };
}

const LIST_SELECT = {
  id: true, refCode: true, buyerName: true, buyerPhone: true, buyerEmail: true, propertyInterest: true, budget: true, city: true, source: true,
  sourceDetail: true, poolGroup: true, poolGroupReason: true, originalLeadAt: true, salesStage: true, temperature: true, nextFollowUpAt: true,
  lastContactedAt: true, contactAttempts: true, intakeAnswers: true,
};

/** This person's calling list (their pool leads still to work) and today's tally. Due follow-ups first, then leads never called, then later ones. */
async function myBatch(user, now = new Date()) {
  requireCaller(user);
  const { start, end } = f.istDayRange(now);
  const [leads, calledToday, waiting] = await Promise.all([
    prisma.lead.findMany({ where: { ...inPool(), ownerStaffId: user.id, poolGroup: { in: TAKE_GROUPS } }, select: LIST_SELECT, take: 300 }),
    prisma.lead.count({ where: { ownerStaffId: user.id, lastContactedAt: { gte: start, lt: end } } }),
    prisma.lead.count({ where: workWaiting(user.id, now) }),
  ]);
  const rank = (l) => {
    if (l.nextFollowUpAt && new Date(l.nextFollowUpAt) < end) return 0; // follow-up due (or overdue)
    if (!l.nextFollowUpAt) return 1; // never called
    return 2; // follow-up in the future
  };
  leads.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 2 || rank(a) === 0 ? new Date(a.nextFollowUpAt) - new Date(b.nextFollowUpAt) : new Date(b.originalLeadAt || 0) - new Date(a.originalLeadAt || 0)));
  const dueToday = leads.filter((l) => rank(l) === 0).length;
  return { leads, summary: { waiting, dueToday, later: leads.filter((l) => rank(l) === 2).length, calledToday, batchSize: BATCH_SIZE, room: Math.max(BATCH_SIZE - waiting, 0) } };
}

/** The follow-up time for "no answer": tomorrow, 10:30 India time. */
function tomorrowMorning(now = new Date()) {
  const { end } = f.istDayRange(now);
  return new Date(end.getTime() + (10 * 60 + 30) * 60 * 1000);
}

/** Record what happened on a call, in one tap. */
async function recordOutcome(user, leadId, body = {}, ip, now = new Date()) {
  requireCaller(user);
  const outcome = body.outcome;
  if (!OUTCOMES.includes(outcome)) throw new ApiError(400, 'Pick what happened on the call.');
  const lead = await leadSales.loadLead(user, leadId); // a BDE gets a 404 for a lead that is not theirs
  if (!isInPool(lead)) throw new ApiError(409, 'This lead is not in the qualification pool any more. Open the lead to work it.', { code: 'NOT_IN_POOL' });

  let followUp = null;
  if (outcome === 'NO_ANSWER') followUp = tomorrowMorning(now);
  if (outcome === 'CALL_LATER') {
    followUp = new Date(body.followUpAt);
    if (Number.isNaN(followUp.getTime())) throw new ApiError(400, 'Pick when to call again.', { code: 'FOLLOW_UP_REQUIRED' });
    if (followUp.getTime() < now.getTime() - DAY_MS || followUp.getTime() > now.getTime() + MAX_FOLLOW_UP_DAYS * DAY_MS) {
      throw new ApiError(400, `Pick a day within the next ${MAX_FOLLOW_UP_DAYS} days.`, { code: 'FOLLOW_UP_INVALID' });
    }
  }
  const text = {
    NO_ANSWER: `Called: no answer. Try again ${followUp && fmtDay(followUp)}.`,
    CALL_LATER: `Called: asked to be called on ${followUp && fmtDay(followUp)}.`,
    INTERESTED: 'Called: interested. Sent to Lead Dispatch.',
    HOT: 'Called: hot, wants to visit soon. Sent to Lead Dispatch.',
    NOT_INTERESTED: 'Called: not interested.',
    WRONG_NUMBER: 'Called: wrong number.',
    DO_NOT_CALL: 'Called: asked not to be contacted again.',
  }[outcome];

  // The call itself (counts the attempt, stamps the time), then the stage change for outcomes that end the chase.
  await leadSales.addNote(user, leadId, { kind: 'CALL', text, ...(followUp && { nextFollowUpAt: followUp.toISOString() }) }, ip);
  const stage = {
    INTERESTED: { salesStage: 'QUALIFIED', temperature: 'WARM' },
    HOT: { salesStage: 'QUALIFIED', temperature: 'HOT' },
    NOT_INTERESTED: { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Not interested' },
    WRONG_NUMBER: { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Wrong number' },
    DO_NOT_CALL: { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Asked not to be contacted' },
  }[outcome];
  if (stage) await leadSales.updateSales(user, leadId, stage, ip);
  if (outcome === 'DO_NOT_CALL' && lead.buyerPhone) {
    const res = await prisma.lead.updateMany({ where: { buyerPhone: lead.buyerPhone }, data: { doNotContactAt: now } });
    createAuditLog({ adminId: user.id, action: 'LEAD_DO_NOT_CONTACT_SET', targetType: 'Lead', targetId: leadId, after: { leadsChanged: res.count, viaCall: true }, ipAddress: ip }).catch(() => null);
  }
  createAuditLog({ adminId: user.id, action: 'LEAD_POOL_CALL_OUTCOME', targetType: 'Lead', targetId: leadId, metadata: { outcome }, ipAddress: ip }).catch(() => null);
  return { outcome, released: outcome === 'INTERESTED' || outcome === 'HOT', nextFollowUpAt: followUp };
}

module.exports = { takeNext, myBatch, recordOutcome, tomorrowMorning, BATCH_SIZE, OUTCOMES };
