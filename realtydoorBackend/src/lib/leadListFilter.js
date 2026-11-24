'use strict';

// The status and search part of the admin leads list (23 Nov 2026), shared by the sales-aware and the older list paths.
// - status: one status or several, comma-separated ("SITE_VISIT_SCHEDULED,SITE_VISIT_DONE" for the "In progress" chip). Unknown values
//   are ignored (they used to go straight into the query and fail).
// - search: reference, buyer name, email, and now the phone number (any 3+ digits of it), across ALL leads, not only one page.

const { LIVE_LEADS, inPool } = require('./poolLeads');

const LEAD_STATUSES = ['AWAITING_ADMIN', 'UNASSIGNED', 'ASSIGNED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE', 'CLOSED', 'DROPPED'];

function statusWhere(raw) {
  if (raw == null || raw === '') return null;
  const list = [...new Set([].concat(raw).flatMap((v) => String(v).split(',')).map((s) => s.trim().toUpperCase()).filter((s) => LEAD_STATUSES.includes(s)))];
  if (!list.length) return { in: [] }; // asked for a status, none valid: match nothing rather than everything
  return list.length === 1 ? list[0] : { in: list };
}

function searchOr(raw) {
  const text = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  if (!text) return null;
  const or = [
    { refCode: { contains: text, mode: 'insensitive' } },
    { buyerName: { contains: text, mode: 'insensitive' } },
    { buyerEmail: { contains: text, mode: 'insensitive' } },
  ];
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 3 && digits.length === text.replace(/[\s+()-]/g, '').length) or.push({ buyerPhone: { contains: digits.slice(-10) } });
  return or;
}

const OPEN_STATUSES = ['UNASSIGNED', 'ASSIGNED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE'];
const STALL_DAYS = 3;

/**
 * The status, search and Lead Monitor conditions for a leads list query.
 * - stalled=1: open and not updated for STALL_DAYS (the Monitor's Stalled tab).
 * - city: the lead's own city or its listing's city.
 */
function leadListFilter(query = {}, now = Date.now()) {
  const where = {};
  const and = [];
  const status = statusWhere(query.status);
  if (status) where.status = status;
  // The qualification pool (lib/poolLeads.js): every list is LIVE leads only, unless the pool screen asks for pool=1 (optionally one batch / group).
  if (query.pool === '1' || query.pool === 1 || query.pool === true) {
    and.push(inPool({ batch: typeof query.batch === 'string' && query.batch ? query.batch.slice(0, 80) : undefined, group: ['A', 'B', 'C'].includes(query.group) ? query.group : undefined }));
  } else {
    and.push(LIVE_LEADS);
  }
  const or = searchOr(query.search);
  if (or) and.push({ OR: or });
  if (query.stalled === '1') {
    and.push({ status: { in: OPEN_STATUSES } }, { updatedAt: { lt: new Date(now - STALL_DAYS * 24 * 60 * 60 * 1000) } });
  }
  const city = typeof query.city === 'string' ? query.city.trim().slice(0, 80) : '';
  if (city) and.push({ OR: [{ city }, { property: { city } }] });
  // A search on its own stays a plain OR (the simplest query); combined with other conditions everything goes under AND.
  if (and.length) where.AND = and;
  return where;
}

module.exports = { leadListFilter, statusWhere, searchOr, LEAD_STATUSES, OPEN_STATUSES, STALL_DAYS };
