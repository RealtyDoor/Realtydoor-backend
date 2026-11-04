const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const li = require('../../lib/leadIntake');
const { createNotification, notifyAdmins } = require('../../lib/notifications');

const REPLY_ALERT_GAP_MS = 10 * 60 * 1000;

// WhatsApp conversations: every message in or out as a thread per phone number, and inbound enquiries from numbers we do not know becoming leads
// (through the same intake as the ad forms). Messages arrive from the WATI webhook; sends from the app are recorded by lib/wati.js.

const MEDIA_WORDS = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', voice: 'AUDIO', document: 'DOCUMENT', file: 'DOCUMENT', location: 'LOCATION', button: 'BUTTON', interactive: 'BUTTON' };
const MEDIA_PLACEHOLDER = { IMAGE: '[Photo]', VIDEO: '[Video]', AUDIO: '[Voice message]', DOCUMENT: '[Document]', LOCATION: '[Location]', BUTTON: '[Button reply]' };

const toPhone = (wa) => {
  const digits = String(wa || '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
};

/** What one WATI webhook message says, in our words. `fromUs` is true for messages our side sent (staff replying in the WATI inbox). */
function readMessage(body = {}) {
  const typeWord = String(body.type || body.messageType || '').toLowerCase();
  const kind = MEDIA_WORDS[typeWord] || (typeWord && typeWord !== 'text' ? 'OTHER' : 'TEXT');
  const text = String(body.text || body.finalText || body.caption || '').trim() || MEDIA_PLACEHOLDER[kind] || (kind === 'OTHER' ? `[${typeWord}]` : '');
  const ref = body.messageReferral || body.referral || (body.sourceId || body.sourceUrl ? { sourceId: body.sourceId, sourceUrl: body.sourceUrl, sourceType: body.sourceType, headline: body.sourceHeadline } : null);
  return {
    phone: toPhone(body.waId || body.whatsappNumber),
    text,
    kind,
    mediaUrl: body.data && /^https?:/.test(String(body.data)) ? String(body.data) : (body.mediaUrl || null),
    senderName: body.senderName || body.operatorName || null,
    watiMessageId: body.whatsappMessageId || body.id || body.messageId || null,
    at: body.timestamp ? new Date(Number(body.timestamp) > 1e12 ? Number(body.timestamp) : Number(body.timestamp) * 1000) : (body.created ? new Date(body.created) : new Date()),
    referral: ref && Object.values(ref).some(Boolean) ? ref : null,
    fromUs: body.owner === true || body.owner === 'true',
  };
}

async function ensureIntegration() {
  const found = await prisma.leadIntegration.findFirst({ where: { kind: 'WHATSAPP' }, include: { mappings: true } });
  if (found) return found;
  // Made once. Nobody posts to it from outside (messages come through the WATI webhook), so its secret is never shown.
  return prisma.leadIntegration.create({
    data: { name: 'WhatsApp (WATI)', kind: 'WHATSAPP', keyId: li.newKeyId(), secretHash: li.hashSecret(crypto.randomBytes(24).toString('hex')), defaultSource: 'WHATSAPP', consentAssumed: true },
    include: { mappings: true },
  });
}

async function note(leadId, text) {
  await prisma.leadNote.create({ data: { leadId, authorName: 'WhatsApp', kind: 'WHATSAPP', text: String(text).slice(0, 800) } }).catch(() => null);
}

// A buyer who already has a lead wrote again: tell whoever owns the lead (or all admins if nobody does), but at most once every 10 minutes
// per lead, so a burst of messages is one alert.
async function alertReply(lead, m) {
  try {
    const link = `/admin/leads/${lead.id}`;
    const recent = await prisma.notification.findFirst({ where: { linkUrl: link, title: 'Buyer replied on WhatsApp', createdAt: { gt: new Date(Date.now() - REPLY_ALERT_GAP_MS) } }, select: { id: true } });
    if (recent) return;
    const title = 'Buyer replied on WhatsApp';
    const message = `${lead.refCode || 'A lead'}${lead.buyerName ? ` · ${lead.buyerName}` : ''}: ${String(m.text).slice(0, 120)}`;
    if (lead.ownerStaffId) await createNotification({ userId: lead.ownerStaffId, title, message, type: 'LEAD_NEW', linkUrl: link });
    else await notifyAdmins({ title, message, type: 'LEAD_NEW', linkUrl: link });
  } catch (err) { logger.warn('[whatsappInbox] reply alert failed', { error: err.message }); }
}

/**
 * A message from the WATI webhook. Stored in the thread (once, by its WATI id). If it is from a number we do not know, it becomes a lead;
 * if the buyer already has a lead, a note goes on it; partners and staff messaging us are not leads.
 */
async function recordMessage(body) {
  const m = readMessage(body);
  if (!m.phone || (!m.text && !m.mediaUrl)) return { status: 'ignored' };

  if (m.watiMessageId) {
    const seen = await prisma.whatsAppMessage.findFirst({ where: { watiMessageId: m.watiMessageId }, select: { id: true } });
    if (seen) return { status: 'seen' };
  }
  const eventType = String(body.eventType || '');
  if (m.fromUs && /template/i.test(eventType)) return { status: 'ignored' }; // sends from the app are already recorded, with their details

  const lead = await prisma.lead.findFirst({ where: { buyerPhone: m.phone }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, refCode: true, ownerStaffId: true, buyerName: true } });
  const row = await prisma.whatsAppMessage.create({
    data: {
      phone: m.phone, direction: m.fromUs ? 'OUT' : 'IN', kind: m.kind, text: m.text || null, mediaUrl: m.mediaUrl, senderName: m.senderName,
      watiMessageId: m.watiMessageId, status: m.fromUs ? 'SENT' : 'RECEIVED', referral: m.referral || undefined, raw: body, at: m.at,
      ...(lead && { leadId: lead.id }),
    },
  });
  if (m.fromUs) return { status: 'recorded', id: row.id };

  if (lead) {
    if (!['CLOSED', 'DROPPED'].includes(lead.status)) {
      await note(lead.id, `Buyer on WhatsApp: ${m.text}`);
      await alertReply(lead, m);
    }
    return { status: 'recorded', id: row.id, leadId: lead.id };
  }
  // A partner, staff member or admin writing to us is not an enquiry.
  const account = await prisma.user.findFirst({ where: { phone: m.phone, deletedAt: { isSet: false } }, select: { role: true } });
  if (account && account.role !== 'USER') return { status: 'recorded', id: row.id };

  const integration = await ensureIntegration();
  const intake = require('../leadIntake/leadIntake.service');
  const out = await intake.ingest(integration, {
    name: m.senderName || 'WhatsApp contact', phone: m.phone, message: m.text, source: 'whatsapp',
    externalId: m.watiMessageId || undefined,
    ...(m.referral && { campaign: m.referral.headline || m.referral.sourceId, adName: m.referral.headline }),
  });
  if (out.leadId) await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { leadId: out.leadId } }).catch(() => null);
  return { status: 'recorded', id: row.id, lead: out.status, leadId: out.leadId || null };
}

const maskedList = (rows) => rows;

/** The chats, newest first, each with its last message and the buyer's lead if there is one. */
async function listConversations({ search, limit = 40 } = {}) {
  const digits = String(search || '').replace(/\D/g, '');
  let phones;
  if (search && !digits) {
    const leads = await prisma.lead.findMany({ where: { buyerName: { contains: String(search), mode: 'insensitive' } }, select: { buyerPhone: true }, take: 50 });
    phones = leads.map((l) => l.buyerPhone);
  }
  const where = digits ? { phone: { contains: digits } } : phones ? { phone: { in: phones } } : {};
  const groups = await prisma.whatsAppMessage.groupBy({ by: ['phone'], where, _max: { at: true }, _count: { _all: true }, orderBy: { _max: { at: 'desc' } }, take: Math.min(limit, 100) });
  const out = [];
  for (const g of groups) {
    const [last, lead] = await Promise.all([
      prisma.whatsAppMessage.findFirst({ where: { phone: g.phone }, orderBy: { at: 'desc' }, select: { direction: true, kind: true, text: true, templateName: true, status: true, at: true } }),
      prisma.lead.findFirst({ where: { buyerPhone: g.phone }, orderBy: { createdAt: 'desc' }, select: { id: true, refCode: true, buyerName: true, status: true, source: true, projectId: true } }),
    ]);
    out.push({ phone: g.phone, name: lead?.buyerName || null, messages: g._count._all, lastAt: g._max.at, last, lead });
  }
  return maskedList(out);
}

/** The conversation as WATI holds it right now (read with the API key, nothing copied). Returns [] if WATI cannot be reached. */
async function fetchLive(phoneDigits, max = 200) {
  if (!process.env.WATI_API_ENDPOINT || !process.env.WATI_ACCESS_TOKEN) return null;
  try {
    const { liveMessages } = require('./watiImport.service');
    return await liveMessages(phoneDigits, max);
  } catch (err) {
    logger.warn('[whatsappInbox] live read failed', { error: err.message });
    return null;
  }
}

/**
 * One chat, oldest first, with the buyer's lead on the side. The messages are read live from WATI, so the whole history is always there and
 * always current; what we stored (the details of what we sent, the lead link) is laid over it. If WATI cannot be reached, what we stored is shown.
 */
async function getThread(phoneDigits, limit = 300) {
  const phone = toPhone(phoneDigits);
  if (!phone) return { messages: [], lead: null };
  const live = await fetchLive(phoneDigits, Math.min(limit, 200));
  if (live) {
    const stored = await prisma.whatsAppMessage.findMany({ where: { phone, watiMessageId: { in: live.map((m) => m.watiMessageId).filter(Boolean) } }, select: { id: true, watiMessageId: true, templateName: true, text: true, leadId: true } });
    const byId = new Map(stored.map((s) => [s.watiMessageId, s]));
    const lead = await prisma.lead.findFirst({ where: { buyerPhone: phone }, orderBy: { createdAt: 'desc' }, select: { id: true, refCode: true, buyerName: true, status: true, source: true, campaign: true, projectId: true, createdAt: true } });
    const messages = live.map((m, i) => {
      const s = byId.get(m.watiMessageId);
      return { id: s?.id || `live-${i}-${m.watiMessageId || ''}`, direction: m.direction, kind: m.kind, text: m.text || s?.text || null, templateName: s?.templateName || m.templateName || null, mediaUrl: m.mediaUrl, senderName: m.senderName, status: m.status, failureReason: m.failureReason || null, at: m.at, deliveredAt: null, readAt: null, leadId: s?.leadId || null, live: !s };
    });
    return { phone, lead, messages, source: 'wati-live' };
  }
  const [messages, lead] = await Promise.all([
    prisma.whatsAppMessage.findMany({ where: { phone }, orderBy: { at: 'desc' }, take: Math.min(limit, 500), select: { id: true, direction: true, kind: true, text: true, templateName: true, mediaUrl: true, senderName: true, status: true, failureReason: true, at: true, deliveredAt: true, readAt: true, leadId: true } }),
    prisma.lead.findFirst({ where: { buyerPhone: phone }, orderBy: { createdAt: 'desc' }, select: { id: true, refCode: true, buyerName: true, status: true, source: true, campaign: true, projectId: true, createdAt: true } }),
  ]);
  return { phone, lead, messages: messages.reverse() };
}

/** Everything known about one message: its text, variables, every delivery event in order, the raw payload and the lead it belongs to. */
async function getMessageDetail(id) {
  const msg = await prisma.whatsAppMessage.findUnique({ where: { id } });
  if (!msg) return null;
  const log = msg.watiMessageId ? await prisma.watiMessageLog.findFirst({ where: { messageId: msg.watiMessageId } }) : null;
  const lead = msg.leadId ? await prisma.lead.findUnique({ where: { id: msg.leadId }, select: { id: true, refCode: true, buyerName: true, status: true, source: true, campaign: true } }) : null;
  return { ...msg, log: log && { status: log.status, templateName: log.templateName, parameters: log.parameters, renderedText: log.renderedText, eventHistory: log.eventHistory, latencyMs: log.latencyMs, costPaise: log.costPaise, failureReason: log.failureReason, sentAt: log.sentAt, deliveredAt: log.deliveredAt, readAt: log.readAt, respondedAt: log.respondedAt }, lead };
}

/** Everything about one delivery-log row (full phone, variables, the message as sent, every status event, cost), with its chat message and lead. */
async function getLogDetail(id) {
  const log = await prisma.watiMessageLog.findUnique({ where: { id } });
  if (!log) return null;
  const thread = log.messageId ? await prisma.whatsAppMessage.findFirst({ where: { watiMessageId: log.messageId } }) : null;
  const leadId = log.leadId || thread?.leadId || null;
  const lead = leadId ? await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, refCode: true, buyerName: true, status: true, source: true, campaign: true } }) : null;
  return { ...log, threadMessageId: thread?.id || null, lead };
}

/** Turn one existing chat into a lead, with the buyer's first message and the ad they came from when known. */
async function createLeadFromChat(phoneDigits) {
  const phone = toPhone(phoneDigits);
  const existing = await prisma.lead.findFirst({ where: { buyerPhone: phone }, orderBy: { createdAt: 'desc' }, select: { id: true, refCode: true } });
  if (existing) return { status: 'EXISTS', leadId: existing.id, refCode: existing.refCode };
  const first = await prisma.whatsAppMessage.findFirst({ where: { phone, direction: 'IN' }, orderBy: { at: 'asc' } });
  const integration = await ensureIntegration();
  const intake = require('../leadIntake/leadIntake.service');
  const ref = first?.referral || null;
  const out = await intake.ingest(integration, {
    name: first?.senderName || 'WhatsApp contact', phone, message: first?.text || undefined, source: 'whatsapp',
    externalId: `chat:${phoneDigits}`,
    ...(ref && { campaign: ref.headline || ref.sourceId || ref.source_id, adName: ref.headline }),
  });
  if (out.leadId) await prisma.whatsAppMessage.updateMany({ where: { phone }, data: { leadId: out.leadId } }).catch(() => null);
  return out;
}

module.exports = { createLeadFromChat, getLogDetail, readMessage, recordMessage, listConversations, getThread, getMessageDetail, ensureIntegration, toPhone };
