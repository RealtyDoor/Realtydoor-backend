const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const { getConfigNumber } = require('../config/config.service');

// Platform default, the last fallback when no card matches. Admin-controlled
// via platform config, consistent with the 2%-is-admin-controlled decision.
const DEFAULT_FEE_PCT_KEY = 'default_fee_pct';
const DEFAULT_FEE_PCT = 2;
const DEFAULT_PARTNER_SHARE_PCT_KEY = 'default_partner_share_pct';
const DEFAULT_PARTNER_SHARE_PCT = 50;

const PAYEE_ROLES = ['PLATFORM', 'LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
const PARTNER_ROLES = ['LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];

// Float arithmetic can't hit 100 exactly (33.33 * 3), so compare on a cent of
// a percent. Tighter than any real negotiation needs, loose enough that
// thirds work.
const PCT_EPSILON = 0.01;

function assertLinesSumTo100(lines) {
  if (!lines?.length) {
    throw new ApiError(400, 'At least one commission line is required', { code: 'NO_COMMISSION_LINES' });
  }
  for (const l of lines) {
    if (!PAYEE_ROLES.includes(l.payeeRole)) {
      throw new ApiError(400, `Unknown payeeRole "${l.payeeRole}"`, { code: 'BAD_PAYEE_ROLE' });
    }
    if (!(l.pct > 0)) {
      throw new ApiError(400, `${l.payeeRole} must have a positive pct`, { code: 'BAD_PCT' });
    }
  }
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.payeeRole)) {
      throw new ApiError(400, `Duplicate line for ${l.payeeRole}`, { code: 'DUPLICATE_PAYEE_ROLE' });
    }
    seen.add(l.payeeRole);
  }
  const sum = lines.reduce((s, l) => s + l.pct, 0);
  if (Math.abs(sum - 100) > PCT_EPSILON) {
    throw new ApiError(400, `Commission lines must sum to 100% of the fee (got ${sum.toFixed(2)}%)`, {
      code: 'LINES_MUST_SUM_TO_100', sum,
    });
  }
}

// ─── Rate cards (templates) ──────────────────────────────────────────────────

async function resolveRateCard({ propertyId, city, sellerType }) {
  // property card → city card. Platform default is handled by the caller,
  // since it isn't a row.
  if (propertyId) {
    const byProperty = await prisma.rateCard.findFirst({
      where: { propertyId, sellerType, isActive: true },
      include: { lines: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (byProperty) return { card: byProperty, source: 'PROPERTY' };
  }
  if (city) {
    const byCity = await prisma.rateCard.findFirst({
      // A card created without a propertyId has the field MISSING, not null,
      // and a plain `null` filter doesn't match that — so city-level cards
      // never resolved and every lead fell through to the platform default.
      where: {
        city: { equals: city, mode: 'insensitive' },
        OR: [{ propertyId: { isSet: false } }, { propertyId: null }],
        sellerType,
        isActive: true,
      },
      include: { lines: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (byCity) return { card: byCity, source: 'CITY' };
  }
  return { card: null, source: 'PLATFORM_DEFAULT' };
}

// The partner override replaces only the PARTNER's total share of the fee. The
// platform's cut is untouched, and the seller's price is untouched — the
// partner's slices are rescaled to fit the new share.
async function resolveOverride(partnerId, propertyId) {
  if (!partnerId) return null;
  const now = new Date();
  const candidates = await prisma.partnerCommissionOverride.findMany({
    where: {
      partnerId,
      isActive: true,
      // isSet: false as well as null — an override created without an expiry
      // has validUntil MISSING in Mongo, and a plain `null` filter does not
      // match a missing field, so a never-expiring override was silently
      // invisible and every lead fell through to the next precedence level.
      OR: [{ validUntil: { isSet: false } }, { validUntil: null }, { validUntil: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
  });
  // A SELECTED override only applies to its listed properties; ALL applies
  // everywhere. Most recent wins.
  return candidates.find((o) =>
    o.scope === 'ALL' || (propertyId && o.propertyIds.includes(propertyId))
  ) || null;
}

// What a lead's terms WOULD be, without writing anything. Used to pre-fill at
// assignment and to show admin a preview before they agree terms.
async function previewTermsForLead(leadId) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, assignedPartnerId: true, propertyId: true,
      property: { select: { id: true, city: true, price: true, partner: { select: { partnerSubType: true } } } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  // Who is selling drives which template applies. Falls back to AGENT, the
  // most common case, when the listing partner has no subtype set.
  const sellerType = lead.property?.partner?.partnerSubType || 'AGENT';
  const { card, source } = await resolveRateCard({
    propertyId: lead.propertyId, city: lead.property?.city, sellerType,
  });

  const [defaultFeePct, defaultPartnerShare] = await Promise.all([
    getConfigNumber(DEFAULT_FEE_PCT_KEY, DEFAULT_FEE_PCT),
    getConfigNumber(DEFAULT_PARTNER_SHARE_PCT_KEY, DEFAULT_PARTNER_SHARE_PCT),
  ]);

  let feePct = card?.feePct ?? defaultFeePct;
  let lines = card?.lines?.length
    ? card.lines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct }))
    // Platform default shape: split the fee between the platform and the
    // closing agent, using the admin-set partner share.
    : [
        { payeeRole: 'PLATFORM', pct: 100 - defaultPartnerShare },
        { payeeRole: 'CLOSING_AGENT', pct: defaultPartnerShare },
      ];

  const override = await resolveOverride(lead.assignedPartnerId, lead.propertyId);
  if (override) lines = applyPartnerShareOverride(lines, override.partnerSharePct);

  return {
    leadId,
    sellerType,
    feePct,
    lines,
    dealPrice: lead.property?.price ?? null,
    resolvedFrom: override ? 'PARTNER_OVERRIDE' : source,
    rateCardId: card?.id ?? null,
    rateCardVersion: card?.version ?? null,
  };
}

// Rescale the partner's slices to a new total share, leaving the platform's
// cut proportionally adjusted so the whole thing still sums to 100.
function applyPartnerShareOverride(lines, partnerSharePct) {
  if (!(partnerSharePct >= 0 && partnerSharePct <= 100)) {
    throw new ApiError(400, 'partnerSharePct must be between 0 and 100');
  }
  const partnerLines = lines.filter((l) => PARTNER_ROLES.includes(l.payeeRole));
  const partnerTotal = partnerLines.reduce((s, l) => s + l.pct, 0);

  const out = [];
  if (partnerTotal > 0) {
    // Preserve the relative split between the partner roles.
    for (const l of partnerLines) {
      out.push({ ...l, pct: round2((l.pct / partnerTotal) * partnerSharePct) });
    }
  } else if (partnerSharePct > 0) {
    out.push({ payeeRole: 'CLOSING_AGENT', pct: round2(partnerSharePct) });
  }

  const platformPct = round2(100 - out.reduce((s, l) => s + l.pct, 0));
  if (platformPct > 0) out.unshift({ payeeRole: 'PLATFORM', pct: platformPct });
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── Lead terms (the money record) ───────────────────────────────────────────

async function getLeadTerms(leadId) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, feePct: true, dealPriceAtLock: true, commissionLockedAt: true,
      commissionVersion: true, rateCardId: true, rateCardVersion: true,
      platformCommissionPct: true, commissionAmountPaise: true, commissionStatus: true,
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const lines = await prisma.leadCommissionLine.findMany({
    where: { leadId, version: lead.commissionVersion },
    orderBy: { payeeRole: 'asc' },
  });

  return { ...lead, lines, locked: !!lead.commissionLockedAt, amounts: computeAmounts(lead, lines) };
}

// fee = price * feePct; each line = fee * pct. Seller residual is derived.
function computeAmounts(lead, lines) {
  const price = lead.dealPriceAtLock;
  if (!price || !lead.feePct) return null;
  const feeAmount = round2((price * lead.feePct) / 100);
  return {
    dealPrice: price,
    feeAmount,
    sellerNet: round2(price - feeAmount),
    byPayee: lines.map((l) => ({
      payeeRole: l.payeeRole,
      payeeUserId: l.payeeUserId ?? null,
      pct: l.pct,
      amount: round2((feeAmount * l.pct) / 100),
    })),
  };
}

// Write (or rewrite) a lead's negotiated lines. Before lock this edits the
// current version in place; after lock it writes a NEW version, since the old
// one is the record of what was already agreed.
async function setLeadTerms(leadId, { feePct, dealPrice, lines, note }, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, assignedPartnerId: true, commissionLockedAt: true, commissionVersion: true,
      feePct: true, dealPriceAtLock: true, property: { select: { price: true } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  assertLinesSumTo100(lines);
  const effectiveFeePct = feePct ?? lead.feePct;
  if (!(effectiveFeePct > 0)) {
    throw new ApiError(400, 'feePct is required (no default could be resolved)', { code: 'FEE_PCT_REQUIRED' });
  }
  const effectivePrice = dealPrice ?? lead.dealPriceAtLock ?? lead.property?.price ?? null;

  const wasLocked = !!lead.commissionLockedAt;
  const version = wasLocked ? lead.commissionVersion + 1 : lead.commissionVersion;

  // Agent-never-earns-on-own-property (3.17): a partner must not be paid for
  // selling a listing they themselves own.
  await assertPartnerNotOwnProperty(leadId, lines);

  await prisma.$transaction([
    // Only the current unlocked version is replaced; superseded versions are
    // left in place as history.
    ...(wasLocked ? [] : [prisma.leadCommissionLine.deleteMany({ where: { leadId, version } })]),
    prisma.leadCommissionLine.createMany({
      data: lines.map((l) => ({
        leadId,
        payeeRole: l.payeeRole,
        payeeUserId: l.payeeUserId ?? (PARTNER_ROLES.includes(l.payeeRole) ? lead.assignedPartnerId : null),
        pct: l.pct,
        reason: l.reason ?? null,
        version,
      })),
    }),
    prisma.lead.update({
      where: { id: leadId },
      data: {
        feePct: effectiveFeePct,
        ...(effectivePrice != null && { dealPriceAtLock: effectivePrice }),
        commissionVersion: version,
        ...derivedFields(effectiveFeePct, lines, effectivePrice),
      },
    }),
  ]);

  await createAuditLog({
    adminId, action: wasLocked ? 'COMMISSION_REVISED' : 'COMMISSION_TERMS_SET',
    targetType: 'Lead', targetId: leadId,
    before: { version: lead.commissionVersion, feePct: lead.feePct },
    after: { version, feePct: effectiveFeePct, lines, note: note ?? null },
    ipAddress: ip,
  });

  return getLeadTerms(leadId);
}

// platformCommissionPct and commissionAmountPaise are derived so netAmount and
// the finance views keep working off the agreed lines.
function derivedFields(feePct, lines, dealPrice) {
  const platformPctOfFee = lines.find((l) => l.payeeRole === 'PLATFORM')?.pct ?? 0;
  // As a % of deal price, which is what platformCommissionPct has always meant.
  const platformCommissionPct = round2((feePct * platformPctOfFee) / 100);
  const out = { platformCommissionPct };
  if (dealPrice != null) {
    out.commissionAmountPaise = Math.round(dealPrice * (platformCommissionPct / 100) * 100);
  }
  return out;
}

// 3.17 — refuse to pay a partner commission on their own listing.
async function assertPartnerNotOwnProperty(leadId, lines) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedPartnerId: true, property: { select: { partnerId: true } } },
  });
  const ownerId = lead?.property?.partnerId;
  if (!ownerId) return;

  const paidPartnerIds = new Set(
    lines.filter((l) => PARTNER_ROLES.includes(l.payeeRole))
      .map((l) => l.payeeUserId ?? lead.assignedPartnerId)
      .filter(Boolean)
  );
  if (paidPartnerIds.has(ownerId)) {
    throw new ApiError(400, 'A partner cannot earn commission on their own listing', {
      code: 'OWN_PROPERTY_COMMISSION',
    });
  }
}

// Pre-fill from the template chain, then hand back the editable draft.
async function prefillLeadTerms(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, commissionLockedAt: true },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.commissionLockedAt) {
    throw new ApiError(400, 'Terms are already locked — revise them instead', { code: 'COMMISSION_LOCKED' });
  }

  const preview = await previewTermsForLead(leadId);
  const saved = await setLeadTerms(leadId, {
    feePct: preview.feePct,
    dealPrice: preview.dealPrice,
    lines: preview.lines,
    note: `Pre-filled from ${preview.resolvedFrom}`,
  }, adminId, ip);

  await prisma.lead.update({
    where: { id: leadId },
    data: { rateCardId: preview.rateCardId, rateCardVersion: preview.rateCardVersion },
  });

  return { ...saved, resolvedFrom: preview.resolvedFrom };
}

async function lockLeadTerms(leadId, adminId, ip) {
  const terms = await getLeadTerms(leadId);
  if (terms.commissionLockedAt) {
    throw new ApiError(400, 'Terms are already locked', { code: 'COMMISSION_LOCKED' });
  }
  if (!terms.lines.length) {
    throw new ApiError(400, 'Set the commission terms before locking', { code: 'NO_COMMISSION_LINES' });
  }
  assertLinesSumTo100(terms.lines);

  const locked = await prisma.lead.update({
    where: { id: leadId },
    data: { commissionLockedAt: new Date() },
  });

  await createAuditLog({
    adminId, action: 'COMMISSION_LOCKED', targetType: 'Lead', targetId: leadId,
    after: { version: locked.commissionVersion, feePct: locked.feePct }, ipAddress: ip,
  });

  return getLeadTerms(leadId);
}

// 3.13 — every version ever written, newest first.
async function getLeadTermsHistory(leadId) {
  const lines = await prisma.leadCommissionLine.findMany({
    where: { leadId },
    orderBy: [{ version: 'desc' }, { payeeRole: 'asc' }],
  });
  const byVersion = new Map();
  for (const l of lines) {
    if (!byVersion.has(l.version)) byVersion.set(l.version, []);
    byVersion.get(l.version).push(l);
  }
  return [...byVersion.entries()].map(([version, v]) => ({ version, lines: v, setAt: v[0].createdAt }));
}

// ─── Rate card CRUD (3.12) ───────────────────────────────────────────────────

async function listRateCards(filters, skip, limit) {
  const where = {};
  if (filters.sellerType) where.sellerType = filters.sellerType;
  if (filters.city) where.city = { equals: filters.city, mode: 'insensitive' };
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.isActive !== undefined) where.isActive = filters.isActive === 'true';

  const [data, total] = await Promise.all([
    prisma.rateCard.findMany({
      where, skip, take: limit, orderBy: { updatedAt: 'desc' },
      include: { lines: true, property: { select: { id: true, title: true, city: true } } },
    }),
    prisma.rateCard.count({ where }),
  ]);
  return { data, total };
}

async function createRateCard(data, adminId, ip) {
  const { lines, ...card } = data;
  assertLinesSumTo100(lines);
  if (!card.propertyId && !card.city) {
    throw new ApiError(400, 'A rate card needs either a propertyId or a city', { code: 'RATE_CARD_NEEDS_SCOPE' });
  }

  const created = await prisma.rateCard.create({
    data: {
      ...card,
      lastChangedByAdminId: adminId,
      lines: { create: lines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct })) },
    },
    include: { lines: true },
  });

  await createAuditLog({
    adminId, action: 'RATE_CARD_CREATED', targetType: 'RateCard', targetId: created.id,
    after: { sellerType: created.sellerType, feePct: created.feePct, lines }, ipAddress: ip,
  });
  return created;
}

async function updateRateCard(id, data, adminId, ip) {
  const card = await prisma.rateCard.findUnique({ where: { id }, include: { lines: true } });
  if (!card) throw new ApiError(404, 'Rate card not found');

  const { lines, ...rest } = data;
  if (lines) assertLinesSumTo100(lines);

  // Version bumps on every content edit, so a lead can record which version
  // it was pre-filled from. Already-locked leads are unaffected — they read
  // their own snapshot and never the card.
  const updated = await prisma.rateCard.update({
    where: { id },
    data: {
      ...rest,
      version: card.version + 1,
      lastChangedByAdminId: adminId,
      ...(lines ? { lines: { deleteMany: {}, create: lines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct })) } } : {}),
    },
    include: { lines: true },
  });

  await createAuditLog({
    adminId, action: 'RATE_CARD_UPDATED', targetType: 'RateCard', targetId: id,
    before: { version: card.version, feePct: card.feePct },
    after: { version: updated.version, feePct: updated.feePct },
    ipAddress: ip,
  });
  return updated;
}

async function deleteRateCard(id, adminId, ip) {
  const card = await prisma.rateCard.findUnique({ where: { id } });
  if (!card) throw new ApiError(404, 'Rate card not found');
  // Deactivated, not deleted: leads reference the version they were
  // pre-filled from and that history shouldn't dangle.
  const updated = await prisma.rateCard.update({ where: { id }, data: { isActive: false } });
  await createAuditLog({
    adminId, action: 'RATE_CARD_DEACTIVATED', targetType: 'RateCard', targetId: id, ipAddress: ip,
  });
  return updated;
}

// ─── Partner overrides (3.14) ────────────────────────────────────────────────

async function listOverrides(filters, skip, limit) {
  const where = {};
  if (filters.partnerId) where.partnerId = filters.partnerId;
  if (filters.isActive !== undefined) where.isActive = filters.isActive === 'true';

  const [data, total] = await Promise.all([
    prisma.partnerCommissionOverride.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: { partner: { select: { id: true, name: true, companyName: true } } },
    }),
    prisma.partnerCommissionOverride.count({ where }),
  ]);
  return { data, total };
}

async function createOverride(data, adminId, ip) {
  const partner = await prisma.user.findFirst({ where: { id: data.partnerId, role: 'PARTNER' }, select: { id: true } });
  if (!partner) throw new ApiError(404, 'Partner not found');
  if (data.scope === 'SELECTED' && !data.propertyIds?.length) {
    throw new ApiError(400, 'A SELECTED override needs at least one propertyId', { code: 'OVERRIDE_NEEDS_PROPERTIES' });
  }

  const created = await prisma.partnerCommissionOverride.create({
    data: { ...data, propertyIds: data.propertyIds ?? [], createdByAdminId: adminId },
  });
  await createAuditLog({
    adminId, action: 'COMMISSION_OVERRIDE_CREATED', targetType: 'PartnerCommissionOverride', targetId: created.id,
    after: { partnerId: created.partnerId, partnerSharePct: created.partnerSharePct, validUntil: created.validUntil },
    ipAddress: ip,
  });
  return created;
}

async function revokeOverride(id, adminId, ip) {
  const o = await prisma.partnerCommissionOverride.findUnique({ where: { id } });
  if (!o) throw new ApiError(404, 'Override not found');
  const updated = await prisma.partnerCommissionOverride.update({ where: { id }, data: { isActive: false } });
  await createAuditLog({
    adminId, action: 'COMMISSION_OVERRIDE_REVOKED', targetType: 'PartnerCommissionOverride', targetId: id, ipAddress: ip,
  });
  return updated;
}

// ─── B12.2 — the partner's view ──────────────────────────────────────────────
// Their effective default plus, per assigned lead, the agreed terms and
// whether they're locked. Only the partner's own slices: the platform's cut
// is not their business.
async function getPartnerRateCards(partnerId) {
  const [override, leads] = await Promise.all([
    prisma.partnerCommissionOverride.findFirst({
      // Same missing-vs-null handling as resolveOverride above.
      where: {
        partnerId,
        isActive: true,
        OR: [{ validUntil: { isSet: false } }, { validUntil: null }, { validUntil: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { partnerSharePct: true, scope: true, validUntil: true, reason: true },
    }),
    prisma.lead.findMany({
      where: { assignedPartnerId: partnerId },
      select: {
        id: true, refCode: true, feePct: true, dealPriceAtLock: true,
        commissionLockedAt: true, commissionVersion: true,
        property: { select: { title: true, city: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const lineRows = leads.length
    ? await prisma.leadCommissionLine.findMany({
        where: { leadId: { in: leads.map((l) => l.id) } },
        select: { leadId: true, payeeRole: true, pct: true, version: true },
      })
    : [];

  const perLead = leads.map((l) => {
    const mine = lineRows.filter((r) =>
      r.leadId === l.id && r.version === l.commissionVersion && PARTNER_ROLES.includes(r.payeeRole)
    );
    const partnerSharePct = mine.reduce((s, r) => s + r.pct, 0) || null;
    const feeAmount = l.dealPriceAtLock && l.feePct ? round2((l.dealPriceAtLock * l.feePct) / 100) : null;
    return {
      leadId: l.id, refCode: l.refCode, property: l.property,
      feePct: l.feePct,
      partnerSharePct,
      partnerAmount: feeAmount && partnerSharePct ? round2((feeAmount * partnerSharePct) / 100) : null,
      locked: !!l.commissionLockedAt,
      lines: mine.map((r) => ({ payeeRole: r.payeeRole, pct: r.pct })),
    };
  });

  return { override: override ?? null, leads: perLead };
}

module.exports = {
  listRateCards, createRateCard, updateRateCard, deleteRateCard,
  listOverrides, createOverride, revokeOverride, getPartnerRateCards,
  resolveRateCard, resolveOverride, previewTermsForLead,
  getLeadTerms, setLeadTerms, prefillLeadTerms, lockLeadTerms, getLeadTermsHistory,
  assertLinesSumTo100, applyPartnerShareOverride, computeAmounts, derivedFields,
  PAYEE_ROLES, PARTNER_ROLES,
};
