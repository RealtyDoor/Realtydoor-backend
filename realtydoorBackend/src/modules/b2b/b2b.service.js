const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');

// ─── B5.9–B5.11 — partner-to-partner inventory feed ──────────────────────────
//
// D2 (decided): hidden inventory IS visible to other verified partners, shown
// with a HIDDEN tag — that's the point of the network. "Hidden" means hidden
// from the *public* site (properties.service.js excludes isB2BOnly from search
// and from slug lookup), not from other partners.
//
// The listing partner's phone and email are deliberately NOT exposed. Admin
// monitors these connections to catch offline bypass (PRD §2.3 / b2b.prisma),
// which only works if the introduction goes through the platform rather than
// partners swapping numbers off the back of the feed. Name and company are
// enough to decide whether to express interest.
const FEED_SELECT = {
  id: true, title: true, slug: true, locality: true, city: true,
  price: true, monthlyRent: true, propertyType: true, listingType: true,
  bhk: true, carpetArea: true, images: true, coverImageIndex: true,
  commissionSplitOffer: true, isB2BOnly: true, b2bUrgent: true, createdAt: true,
  partner: { select: { id: true, name: true, companyName: true, partnerSubType: true } },
};

// Everything a verified partner may see: approved listings that aren't their
// own. Both co-list (public) and hidden (B2B-only) inventory.
function feedWhere(partnerId, filters = {}) {
  const where = {
    publishStatus: 'APPROVED',
    partnerId: { not: partnerId },
  };
  if (filters.city)     where.city = { equals: filters.city, mode: 'insensitive' };
  if (filters.locality) where.locality = { contains: filters.locality, mode: 'insensitive' };
  if (filters.propertyType) where.propertyType = filters.propertyType;
  if (filters.kind === 'HIDDEN')  where.isB2BOnly = true;
  if (filters.kind === 'CO_LIST') where.isB2BOnly = false;
  if (filters.urgent === 'true')  where.b2bUrgent = true;
  return where;
}

function shapeRow(p, interestedPropertyIds) {
  const { isB2BOnly, ...rest } = p;
  return {
    ...rest,
    // The frontend's "Hidden" vs co-list tag.
    kind: isB2BOnly ? 'HIDDEN' : 'CO_LIST',
    // So the feed can render "Interest sent" instead of offering the button
    // again — the unique constraint on (buyerPartnerId, propertyId) means a
    // second attempt would 409 anyway.
    alreadyInterested: interestedPropertyIds.has(p.id),
  };
}

async function getFeed(partnerId, filters, skip, limit) {
  const where = feedWhere(partnerId, filters);

  const [data, total, myInterests] = await Promise.all([
    prisma.property.findMany({
      where, skip, take: limit,
      orderBy: [{ b2bUrgent: 'desc' }, { createdAt: 'desc' }],
      select: FEED_SELECT,
    }),
    prisma.property.count({ where }),
    prisma.b2BConnection.findMany({
      where: { buyerPartnerId: partnerId },
      select: { propertyId: true },
    }),
  ]);

  const interested = new Set(myInterests.map((c) => c.propertyId));
  return { data: data.map((p) => shapeRow(p, interested)), total };
}

// B5.11 — counts for the filter chips. Computed over the same visibility rule
// as the feed itself, so a chip can never promise rows the feed won't return.
async function getFeedCounts(partnerId) {
  const base = feedWhere(partnerId);

  const [total, hidden, urgent, plots, byCity] = await Promise.all([
    prisma.property.count({ where: base }),
    prisma.property.count({ where: { ...base, isB2BOnly: true } }),
    prisma.property.count({ where: { ...base, b2bUrgent: true } }),
    prisma.property.count({ where: { ...base, propertyType: 'PLOT' } }),
    prisma.property.groupBy({
      by: ['city'],
      where: base,
      _count: { city: true },
      orderBy: { _count: { city: 'desc' } },
      take: 20,
    }),
  ]);

  return {
    total,
    hidden,
    coList: total - hidden,
    urgent,
    plots,
    byCity: byCity.map((c) => ({ city: c.city, count: c._count.city })),
  };
}

// B5.10 — express interest. Creates the connection admin monitors; it does
// not reveal the listing partner's contact details, and deliberately doesn't
// auto-connect either — admin/listing-partner action moves it to CONNECTED.
async function expressInterest(partnerId, propertyId, message) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, publishStatus: 'APPROVED' },
    select: { id: true, title: true, partnerId: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId === partnerId) {
    throw new ApiError(400, 'This is your own listing', { code: 'OWN_LISTING' });
  }

  const existing = await prisma.b2BConnection.findFirst({
    where: { buyerPartnerId: partnerId, propertyId },
    select: { id: true, status: true, createdAt: true },
  });
  if (existing) {
    throw new ApiError(409, 'You have already expressed interest in this listing', {
      code: 'ALREADY_INTERESTED',
      connection: existing,
    });
  }

  const me = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { name: true, companyName: true },
  });

  const connection = await prisma.b2BConnection.create({
    data: {
      listingPartnerId: property.partnerId,
      buyerPartnerId: partnerId,
      propertyId,
      status: 'INTERESTED',
      message: message ?? null,
    },
  });

  // The listing partner is told who is interested, and admins are told a
  // connection was formed — the bypass-detection trail starts here.
  const who = me?.companyName || me?.name || 'A partner';
  await createNotification({
    userId: property.partnerId,
    title: 'Partner interested in your listing',
    message: `${who} expressed interest in "${property.title}".`,
    type: 'B2B_INTEREST',
    linkUrl: `/partners/b2b/${connection.id}`,
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((a) => createNotification({
    userId: a.id,
    title: 'New B2B connection',
    message: `${who} expressed interest in "${property.title}".`,
    type: 'B2B_INTEREST',
    linkUrl: '/admin/b2b',
  })));

  return connection;
}

// A partner's own interests, and interest received on their listings.
async function getMyConnections(partnerId, filters, skip, limit) {
  const direction = filters.direction === 'RECEIVED' ? 'listingPartnerId' : 'buyerPartnerId';
  const where = { [direction]: partnerId };
  if (filters.status) where.status = filters.status;

  const [data, total] = await Promise.all([
    prisma.b2BConnection.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true, city: true, locality: true, price: true, commissionSplitOffer: true } },
        // Whichever side the caller isn't. Still no contact details — a
        // connection existing doesn't change the bypass-prevention rule.
        listingPartner: { select: { id: true, name: true, companyName: true } },
        buyerPartner:   { select: { id: true, name: true, companyName: true } },
      },
    }),
    prisma.b2BConnection.count({ where }),
  ]);
  return { data, total };
}

// ─── Admin (B5.10's "tracking by Admin") ─────────────────────────────────────

async function adminListConnections(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.partnerId) {
    where.OR = [{ listingPartnerId: filters.partnerId }, { buyerPartnerId: filters.partnerId }];
  }

  const [data, total] = await Promise.all([
    prisma.b2BConnection.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property:       { select: { id: true, title: true, slug: true, city: true, price: true, isB2BOnly: true } },
        // Admin DOES get contact details — monitoring offline bypass is the
        // reason this view exists.
        listingPartner: { select: { id: true, name: true, companyName: true, email: true, phone: true } },
        buyerPartner:   { select: { id: true, name: true, companyName: true, email: true, phone: true } },
      },
    }),
    prisma.b2BConnection.count({ where }),
  ]);
  return { data, total };
}

async function adminUpdateConnection(id, status, adminId) {
  const conn = await prisma.b2BConnection.findUnique({ where: { id } });
  if (!conn) throw new ApiError(404, 'Connection not found');

  const updated = await prisma.b2BConnection.update({ where: { id }, data: { status } });

  await Promise.all([conn.buyerPartnerId, conn.listingPartnerId].map((userId) => createNotification({
    userId,
    title: `B2B connection ${status.toLowerCase()}`,
    message: `A B2B connection you are part of is now ${status}.`,
    type: 'B2B_INTEREST',
    linkUrl: '/partners/b2b',
  })));

  return updated;
}

module.exports = {
  getFeed, getFeedCounts, expressInterest, getMyConnections,
  adminListConnections, adminUpdateConnection,
};
