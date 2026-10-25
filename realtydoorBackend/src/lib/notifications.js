const prisma = require('./prisma');
const { canSend } = require('./notificationGate');
const logger = require('./logger');

// 10.1 / B6.1 — the notification pages group by category chips (Leads,
// Escrow, KYC, Listings, System). Derived from `type` here rather than asked
// of ~40 call sites: they keep working unchanged, and the mapping can't drift
// between callers. An unmapped type falls back to SYSTEM, which is also what
// the frontend's catch-all chip shows.
const CATEGORY_BY_TYPE = {
  LEAD_NEW: 'LEADS',
  LEAD_ASSIGNED: 'LEADS',
  LEAD_DROPPED: 'LEADS',
  OTP_OVERRIDE_REQUESTED: 'LEADS',
  DEAL_CLOSED: 'LEADS',
  ESCROW_HELD: 'ESCROW',
  ESCROW_RELEASED: 'ESCROW',
  ESCROW_REFUNDED: 'ESCROW',
  PAYMENT_FAILED: 'ESCROW',
  PAYMENT_REFUNDED: 'ESCROW',
  PAYOUT_FAILED: 'ESCROW',
  // R31 — RazorpayX confirmed the payout and the UTR is now known.
  PAYOUT_PROCESSED: 'ESCROW',
  KYC_PENDING: 'KYC',
  KYC_UPDATE: 'KYC',
  PROPERTY_APPROVED: 'LISTINGS',
  PROPERTY_REJECTED: 'LISTINGS',
  LISTING_UPDATE: 'LISTINGS',
  // PROPERTY_EDITED_BY_ADMIN was already being emitted by admin.service.js
  // but was missing here, so it fell through to the SYSTEM catch-all instead
  // of showing under the Listings chip.
  PROPERTY_EDITED_BY_ADMIN: 'LISTINGS',
  // 4.8 / 4.9 — outcome of a partner's edit to a live listing.
  PROPERTY_CHANGES_APPROVED: 'LISTINGS',
  PROPERTY_CHANGES_REJECTED: 'LISTINGS',
  // 4.3 — mandate lifecycle.
  MANDATE_REVOKED: 'LISTINGS',
  // 4.7 — admin moved the listing on the map.
  PROPERTY_LOCATION_EDITED: 'LISTINGS',
  // 4.15 — admin asked for fixes rather than rejecting.
  PROPERTY_CHANGES_REQUESTED: 'LISTINGS',
  // 4.1 — a checklist document needed resubmission.
  LISTING_DOCUMENT_REJECTED: 'LISTINGS',
  // R27 — an owner self-reported a listing as unauthorized.
  LISTING_OWNER_REPORTED: 'LISTINGS',
  SERVICE_ACTIVATED: 'SYSTEM',
  // 7.x — post-purchase service ticket lifecycle, distinct from every
  // existing chip (not a lead, not escrow money movement, not a listing).
  TICKET_VENDOR_DISPATCHED: 'SERVICES',
  TICKET_VENDOR_REASSIGNED: 'SERVICES',
  TICKET_RESOLVED: 'SERVICES',
  TICKET_ADMIN_REPLY: 'SERVICES',
  // B42 — the admin-facing side of the same lifecycle.
  TICKET_NEW: 'SERVICES',
  TICKET_USER_NOTE: 'SERVICES',
  // Partner support tickets (Help & Support, partner side) — distinct from
  // the buyer-facing post-purchase TICKET_* types above, so SYSTEM rather
  // than SERVICES.
  PARTNER_TICKET_UPDATED: 'SYSTEM',
  LOAN_STATUS_UPDATE: 'SYSTEM',
  ANNOUNCEMENT: 'SYSTEM',
  // R32 — a partner's own earnings on a deal, distinct from ESCROW (whether
  // the *money itself* moved) and LEADS (the deal's own lifecycle).
  COMMISSION_LOCKED: 'FEES',
  // The partner's tax invoice and commission voucher (money model phase 2).
  TAX_INVOICE_UPLOADED: 'FEES',
  TAX_INVOICE_ACCEPTED: 'FEES',
  TAX_INVOICE_REJECTED: 'FEES',
  COMMISSION_VOUCHER: 'FEES',
  COMMISSION_VOUCHER_READY: 'FEES',
  // R29 — affects whether an advisor earns anything on a referred buyer at all.
  ADVISOR_REFERRAL_REVOKED: 'FEES',
  // R26 — the owner's success-fee payment lifecycle.
  COMMISSION_INVOICED: 'FEES',
  COMMISSION_COLLECTED: 'FEES',
  COMMISSION_FEE_REMINDER: 'FEES',
  // R28 — the builder's brokerage-invoice payment lifecycle.
  BUILDER_INVOICE_ISSUED: 'FEES',
  BUILDER_INVOICE_COLLECTED: 'FEES',
};

const NOTIFICATION_CATEGORIES = ['LEADS', 'ESCROW', 'KYC', 'LISTINGS', 'FEES', 'SERVICES', 'SYSTEM'];

function categoryFor(type) {
  return CATEGORY_BY_TYPE[type] || 'SYSTEM';
}

// Privacy spec, 2026-10-10 — gated by notifPush: there's no FCM/APNs
// integration in this codebase, so this Notification row (the in-app bell/
// list) is the only thing the Settings screen's "Push notifications" toggle
// can actually control. Looked up by id rather than asked of every one of
// the ~40 call sites, same reasoning as categoryFor below.
async function createNotification({ userId, title, message, type, linkUrl }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notifPush: true } });
  if (!canSend({ user, channel: 'PUSH' })) return null;
  return prisma.notification.create({
    data: { userId, title, message, type, category: categoryFor(type), linkUrl: linkUrl || null },
  });
}

async function broadcastNotification({ userIds, title, message, type, linkUrl }) {
  const category = categoryFor(type);
  const allowedUsers = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, notifPush: true },
  });
  const allowedIds = allowedUsers.filter((u) => canSend({ user: u, channel: 'PUSH' })).map((u) => u.id);
  if (!allowedIds.length) return { count: 0 };
  return prisma.notification.createMany({
    data: allowedIds.map((userId) => ({ userId, title, message, type, category, linkUrl: linkUrl || null })),
  });
}

// Same notification to every admin. Failures are swallowed: this is called
// from the tail of a user-facing write that has already succeeded, and an
// admin bell hiccup must not turn it into an error response.
async function notifyAdmins({ title, message, type, linkUrl }) {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    if (!admins.length) return { count: 0 };
    return await broadcastNotification({ userIds: admins.map((a) => a.id), title, message, type, linkUrl });
  } catch (err) {
    logger.warn('[Notifications] notifyAdmins failed', { type, error: err.message });
    return { count: 0 };
  }
}

// B16 — an action notification ("needs review") should stop nagging once the
// action is taken. Marks matching unread rows read; best-effort, never throws.
async function markNotificationsRead({ linkUrl, types }) {
  try {
    return await prisma.notification.updateMany({
      where: { linkUrl, isRead: false, ...(types?.length && { type: { in: types } }) },
      data: { isRead: true, readAt: new Date() },
    });
  } catch (err) {
    logger.warn('[Notifications] markNotificationsRead failed', { linkUrl, error: err.message });
    return { count: 0 };
  }
}

module.exports = {
  createNotification, broadcastNotification, notifyAdmins, markNotificationsRead,
  categoryFor, NOTIFICATION_CATEGORIES, CATEGORY_BY_TYPE,
};
