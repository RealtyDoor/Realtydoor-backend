const axios = require('axios');
const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const ApiError = require('../../utils/ApiError');

// Copies the conversations that already exist in WATI into our chat threads (WhatsAppMessage). WATI lists contacts newest first, so an import
// starts with the recent ones and goes back as far as the date given. It is safe to run again: a message already copied is skipped.
// Leads are NOT made from old chats (most of a WATI account is bulk-campaign recipients): an admin turns a chat into a lead with one click.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const CONTACTS_PER_PAGE = 20;
const MAX_MESSAGES_PER_CONTACT = 500;

const client = () => axios.create({
  baseURL: process.env.WATI_API_ENDPOINT,
  headers: { Authorization: `Bearer ${process.env.WATI_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  timeout: 30000,
});

/** WATI writes a contact's created date as "Nov-04-2026". */
function parseContactDate(s) {
  const m = /^([A-Za-z]{3})[-\s](\d{1,2})[-,\s]+(\d{4})$/.exec(String(s || '').trim());
  if (!m) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])));
}

function statusOf(item) {
  const s = String(item.statusString || '').toUpperCase();
  if (s.includes('READ')) return 'READ';
  if (s.includes('DELIVER')) return 'DELIVERED';
  if (s.includes('FAIL')) return 'FAILED';
  if (s.includes('REPLIED') || s.includes('RESPOND')) return 'RESPONDED';
  return 'SENT';
}

const KIND_BY_TYPE = { text: 'TEXT', image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', document: 'DOCUMENT', location: 'LOCATION' };

/** One WATI message item as one chat row, or null for the ones that are not messages (ticket events such as assignments). */
function toRow(item, phone, leadId) {
  if (!item || item.eventType === 'ticket') return null;
  const text = String(item.text || item.finalText || '').trim();
  const typeWord = String(item.type ?? '').toLowerCase();
  const kind = item.eventType === 'broadcastMessage' ? 'TEMPLATE' : (KIND_BY_TYPE[typeWord] || (typeWord && typeWord !== 'text' && !/^\d+$/.test(typeWord) ? 'OTHER' : 'TEXT'));
  const mediaUrl = item.data && /^https?:/.test(String(item.data)) ? String(item.data) : null;
  if (!text && !mediaUrl) return null;
  const inbound = item.owner === false;
  const ref = item.messageReferral && typeof item.messageReferral === 'object' && Object.keys(item.messageReferral).length ? item.messageReferral : null;
  const id = item.whatsappMessageId || item.id;
  return {
    phone, direction: inbound ? 'IN' : 'OUT', kind, text: text || (mediaUrl ? '[Attachment]' : null), mediaUrl,
    senderName: inbound ? (item.contactName || null) : (item.operatorName || null),
    watiMessageId: id ? String(id) : null,
    status: inbound ? 'RECEIVED' : statusOf(item),
    ...(item.failedDetail && { failureReason: String(item.failedDetail).slice(0, 300) }),
    ...(ref && { referral: ref }),
    ...(leadId && { leadId }),
    at: item.created ? new Date(item.created) : new Date(),
  };
}

/**
 * Import one slice: `pages` pages of contacts starting at `startPage`, stopping early at a contact older than `since`.
 * Returns what it did and where to continue. `dryRun` only counts.
 */
async function importSlice({ since, startPage = 1, pages = 3, dryRun = false } = {}) {
  if (!process.env.WATI_API_ENDPOINT || !process.env.WATI_ACCESS_TOKEN) throw new ApiError(400, 'WATI is not connected: the API address and token are not set.');
  const http = client();
  const sinceDate = since ? new Date(since) : null;
  const out = { contacts: 0, withReplies: 0, messages: 0, inbound: 0, skipped: 0, nextPage: startPage, done: false, total: null };

  for (let p = startPage; p < startPage + pages; p += 1) {
    const res = await http.get('/api/v1/getContacts', { params: { pageSize: CONTACTS_PER_PAGE, pageNumber: p } });
    const list = res.data?.contact_list || [];
    out.total = res.data?.link?.total ?? out.total;
    if (list.length === 0) { out.done = true; break; }
    let newInPage = 0;
    for (const contact of list) {
      const created = parseContactDate(contact.created);
      // WATI lists newest first, but an old contact that wrote again floats up, so an old one is skipped, not a reason to stop.
      if (sinceDate && created && created < sinceDate) continue;
      newInPage += 1;
      const digits = String(contact.wAid || contact.phone || '').replace(/\D/g, '');
      if (digits.length < 8) continue;
      const phone = `+${digits}`;
      out.contacts += 1;

      const items = [];
      for (let mp = 1; items.length < MAX_MESSAGES_PER_CONTACT; mp += 1) {
        const m = await http.get(`/api/v1/getMessages/${digits}`, { params: { pageSize: 100, pageNumber: mp } }).catch((err) => {
          if (err.response?.status === 404) return null;
          throw err;
        });
        const page = m?.data?.messages?.items || [];
        items.push(...page);
        if (!m?.data?.messages?.hasNextPage || page.length === 0) break;
      }
      if (items.some((i) => i.owner === false)) out.withReplies += 1;

      const lead = dryRun ? null : await prisma.lead.findFirst({ where: { buyerPhone: phone }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      const rows = items.map((i) => toRow(i, phone, lead?.id)).filter(Boolean);
      out.skipped += items.length - rows.length;
      out.inbound += rows.filter((r) => r.direction === 'IN').length;
      if (dryRun) { out.messages += rows.length; continue; }

      const ids = rows.map((r) => r.watiMessageId).filter(Boolean);
      const have = ids.length ? new Set((await prisma.whatsAppMessage.findMany({ where: { watiMessageId: { in: ids } }, select: { watiMessageId: true } })).map((x) => x.watiMessageId)) : new Set();
      const fresh = rows.filter((r) => !r.watiMessageId || !have.has(r.watiMessageId));
      if (fresh.length) await prisma.whatsAppMessage.createMany({ data: fresh });
      out.messages += fresh.length;
      out.skipped += rows.length - fresh.length;
    }
    out.nextPage = p + 1;
    // A whole page of old contacts means everything after it is older too.
    if (sinceDate && newInPage === 0) { out.done = true; break; }
    if (list.length < CONTACTS_PER_PAGE) { out.done = true; break; }
  }
  logger.info('[watiImport] slice done', { ...out });
  return out;
}

/** One contact's conversation read straight from WATI, oldest first, as chat rows. Nothing is written. */
async function liveMessages(phoneDigits, max = 200) {
  const http = client();
  const phone = `+${String(phoneDigits).replace(/\D/g, '')}`;
  const items = [];
  for (let mp = 1; items.length < max; mp += 1) {
    const m = await http.get(`/api/v1/getMessages/${String(phoneDigits).replace(/\D/g, '')}`, { params: { pageSize: 100, pageNumber: mp } });
    const page = m?.data?.messages?.items || [];
    items.push(...page);
    if (!m?.data?.messages?.hasNextPage || page.length === 0) break;
  }
  return items.map((i) => toRow(i, phone)).filter(Boolean).sort((a, b) => a.at - b.at).slice(-max);
}

module.exports = { liveMessages, importSlice, parseContactDate, toRow, statusOf, CONTACTS_PER_PAGE };
