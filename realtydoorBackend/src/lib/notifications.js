const prisma = require('./prisma');

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
  SERVICE_ACTIVATED: 'SYSTEM',
  LOAN_STATUS_UPDATE: 'SYSTEM',
  ANNOUNCEMENT: 'SYSTEM',
};

const NOTIFICATION_CATEGORIES = ['LEADS', 'ESCROW', 'KYC', 'LISTINGS', 'SYSTEM'];

function categoryFor(type) {
  return CATEGORY_BY_TYPE[type] || 'SYSTEM';
}

async function createNotification({ userId, title, message, type, linkUrl }) {
  return prisma.notification.create({
    data: { userId, title, message, type, category: categoryFor(type), linkUrl: linkUrl || null },
  });
}

async function broadcastNotification({ userIds, title, message, type, linkUrl }) {
  const category = categoryFor(type);
  return prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, title, message, type, category, linkUrl: linkUrl || null })),
  });
}

module.exports = {
  createNotification, broadcastNotification,
  categoryFor, NOTIFICATION_CATEGORIES, CATEGORY_BY_TYPE,
};
