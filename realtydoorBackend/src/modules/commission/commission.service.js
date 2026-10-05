const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { getConfigNumber, getConfigValue } = require('../config/config.service');
const { isSelfListedByAgent } = require('../listings/integrity.service');
const { getActiveReferralForPhone } = require('../referrals/referral.service');
const { buildCommissionReceiptPdf } = require('../../lib/pdfReceipt');
const { s3Upload } = require('../../lib/fileUpload');

// backend-gaps-frontend-integration.md #1 — reverses the 826a73c leftover-
// margin decision. The platform-default fee/share pre-fill is still
// config-controlled (an admin decision, just made once at platform level
// instead of per lead), but there is deliberately no hardcoded JS number
// fallback any more: "Admin sets every percentage" means nothing is ever
// silently guessed by code. If neither a rate card nor this config key
// exists, there's nothing to pre-fill and admin must enter terms by hand.
const DEFAULT_FEE_PCT_KEY = 'default_fee_pct';
const DEFAULT_PARTNER_SHARE_PCT_KEY = 'default_partner_share_pct';

// backend-gaps-frontend-integration.md #1, section 19 — R, the platform's
// cost-recovery retained amount, calculated from the real payment-gateway
// charges actually incurred on this fee (NOT a business margin, and NOT
// admin-entered). All four switchable via platform config — same mechanism
// as escrow.service.js's GST/TDS/fee-rate keys — and all default to 0 (a
// safe no-op) until the real Razorpay/RazorpayX schedule is supplied.
const GATEWAY_COLLECTION_PCT_KEY = 'commission_gateway_collection_pct';
const GATEWAY_PAYOUT_PCT_KEY = 'commission_gateway_payout_pct';
const GATEWAY_GST_PCT_KEY = 'commission_gateway_gst_pct';
// Open with the accountant (confirm): whether GST paid on gateway charges is
// claimed back as input credit. 'true' = it is (so it's not a real cost and
// is excluded from R); 'false' (default) = it is not, so it's added to R.
const GATEWAY_GST_INPUT_CREDIT_KEY = 'commission_gateway_gst_input_credit';

const PAYEE_ROLES = ['LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
const PARTNER_ROLES = ['LISTING_AGENT', 'CLOSING_AGENT', 'ADVISOR'];
// LISTING_AGENT/CLOSING_AGENT default their payeeUserId to the lead's
// assigned partner when not given explicitly. ADVISOR never does — an
// advisor is always a different person, so it must always be named.
const ASSIGNED_PARTNER_ROLES = ['LISTING_AGENT', 'CLOSING_AGENT'];

// Float/rupee arithmetic can't land on an exact boundary, so compare with a
// cent of slack rather than requiring bit-for-bit equality.
const PCT_EPSILON = 0.01;
const RUPEE_EPSILON = 0.01;

async function getGatewayRates() {
  const [collectionPct, payoutPct, gstPct, inputCreditRaw] = await Promise.all([
    getConfigNumber(GATEWAY_COLLECTION_PCT_KEY, 0),
    getConfigNumber(GATEWAY_PAYOUT_PCT_KEY, 0),
    getConfigNumber(GATEWAY_GST_PCT_KEY, 0),
    getConfigValue(GATEWAY_GST_INPUT_CREDIT_KEY, 'false'),
  ]);
  return { collectionPct, payoutPct, gstPct, inputCreditClaimed: inputCreditRaw === 'true' };
}

// R = (collection charge + payout transfer charge) + GST on both — unless
// GST is claimed as input credit, in which case it's recoverable and so not
// a real cost, and R excludes it. feeAmount is B; pass null when it isn't
// known yet (price/feePct not set) and R comes back 0 (nothing to compute
// against yet, not a false "no cost" claim).
function computePlatformRetained(feeAmount, rates) {
  if (!feeAmount) return { retainedAmount: 0, platformPctOfFee: 0 };
  const rawCost = round2((feeAmount * (rates.collectionPct + rates.payoutPct)) / 100);
  const gst = round2((rawCost * rates.gstPct) / 100);
  const retainedAmount = rates.inputCreditClaimed ? rawCost : round2(rawCost + gst);
  const platformPctOfFee = round2((retainedAmount / feeAmount) * 100);
  return { retainedAmount, platformPctOfFee };
}

// backend-gaps-frontend-integration.md #1 — PLATFORM is no longer a
// commission LINE at all: its share is R, a gateway-cost figure computed
// independently of what admin enters here (see computePlatformRetained
// above), not a residual of these lines reaching 100%. This only resolves
// and validates the PARTNER lines actually submitted — the ΣPi + R > B
// refusal happens in setLeadTerms, once R is known.
//
// feeAmount (rupees) is required to convert an ADVISOR flat amount into its
// equivalent % of the fee — pass null when it isn't known yet (e.g. a rate
// card template, which never carries an ADVISOR line at all, or a lead whose
// price isn't set yet) and a flat-amount ADVISOR line will be refused with a
// clear reason instead of silently producing a wrong percentage.
function resolvePartnerLines(inputLines, feeAmount) {
  const submitted = inputLines || [];
  if (!submitted.length) {
    throw new ApiError(400, 'At least one commission line is required', { code: 'NO_COMMISSION_LINES' });
  }

  const seen = new Set();
  const resolved = [];
  for (const l of submitted) {
    if (!PARTNER_ROLES.includes(l.payeeRole)) {
      throw new ApiError(400, `Unknown payeeRole "${l.payeeRole}"`, { code: 'BAD_PAYEE_ROLE' });
    }
    if (seen.has(l.payeeRole)) {
      throw new ApiError(400, `Duplicate line for ${l.payeeRole}`, { code: 'DUPLICATE_PAYEE_ROLE' });
    }
    seen.add(l.payeeRole);

    if (l.payeeRole === 'ADVISOR' && l.flatAmountPaise != null) {
      if (!(l.flatAmountPaise > 0)) {
        throw new ApiError(400, 'ADVISOR flatAmountPaise must be positive', { code: 'BAD_FLAT_AMOUNT' });
      }
      if (!feeAmount) {
        throw new ApiError(400, 'A flat ADVISOR amount needs a known fee amount — set feePct and a deal price first', { code: 'FLAT_AMOUNT_NEEDS_FEE' });
      }
      if (l.flatAmountPaise > Math.round(feeAmount * 100)) {
        throw new ApiError(400, "ADVISOR's flat amount cannot exceed the fee itself", { code: 'FLAT_AMOUNT_EXCEEDS_FEE' });
      }
      resolved.push({ ...l, pct: round2((l.flatAmountPaise / 100 / feeAmount) * 100), flatAmountPaise: l.flatAmountPaise });
    } else {
      if (!(l.pct > 0)) {
        throw new ApiError(400, `${l.payeeRole} must have a positive pct`, { code: 'BAD_PCT' });
      }
      resolved.push({ ...l, flatAmountPaise: null });
    }
  }

  return resolved;
}

// Rate card templates: no ADVISOR (deal-specific, not knowable at
// template-design time — see the schema comment), no flat amounts, nothing
// to convert, and no PLATFORM line — a template only ever holds partner
// defaults now. Still bounded at 100%: a template whose partner lines alone
// already exceed the whole fee is nonsensical regardless of what R turns
// out to be for any specific lead it's later applied to.
function resolveRateCardLines(inputLines) {
  const submitted = inputLines || [];
  if (!submitted.length) {
    throw new ApiError(400, 'At least one commission line is required', { code: 'NO_COMMISSION_LINES' });
  }
  const seen = new Set();
  for (const l of submitted) {
    if (!ASSIGNED_PARTNER_ROLES.includes(l.payeeRole)) {
      throw new ApiError(400,
        `Rate card templates only support LISTING_AGENT/CLOSING_AGENT lines (got "${l.payeeRole}"). `
        + 'ADVISOR is set per deal, not in a template, since the specific advisor is not known in advance.',
        { code: 'BAD_PAYEE_ROLE' });
    }
    if (seen.has(l.payeeRole)) {
      throw new ApiError(400, `Duplicate line for ${l.payeeRole}`, { code: 'DUPLICATE_PAYEE_ROLE' });
    }
    seen.add(l.payeeRole);
    if (!(l.pct > 0)) throw new ApiError(400, `${l.payeeRole} must have a positive pct`, { code: 'BAD_PCT' });
  }
  const sum = submitted.reduce((s, l) => s + l.pct, 0);
  if (sum > 100 + PCT_EPSILON) {
    throw new ApiError(400,
      `These lines sum to ${sum.toFixed(2)}% of the fee, which leaves nothing for the platform's cost recovery.`,
      { code: 'LINES_EXCEED_FEE', sum });
  }
  return submitted;
}

// Safety net at lock time only — the lines being locked already passed this
// exact check in setLeadTerms, so it should never actually fail. It exists
// to catch a future bug in that check rather than to validate fresh admin
// input a second time.
function assertStoredLinesFitHeadroom(lines, feeAmount, retainedAmount) {
  if (feeAmount == null) return;
  const partnerTotal = lines.reduce((s, l) => s + (l.flatAmountPaise != null ? l.flatAmountPaise / 100 : round2((feeAmount * l.pct) / 100)), 0);
  if (round2(partnerTotal + retainedAmount) > feeAmount + RUPEE_EPSILON) {
    throw new ApiError(400,
      `Stored lines (₹${round2(partnerTotal)}) plus the platform's retained amount (₹${retainedAmount}) exceed the fee (₹${feeAmount}) — this is a bug, not an input error`,
      { code: 'LINES_EXCEED_HEADROOM', partnerTotal, retainedAmount, feeAmount });
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
      id: true, assignedPartnerId: true, propertyId: true, buyerPhone: true, city: true,
      property: { select: { id: true, city: true, price: true, partnerId: true, partner: { select: { partnerSubType: true } } } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  // Who is selling drives which template applies. Falls back to AGENT, the
  // most common case, when the listing partner has no subtype set.
  //
  // R21 — an AGENT who is also the mandate's owner-of-record isn't bringing
  // a genuinely separate listing; there's no third-party owner paying an
  // agent's cut on top of the platform fee, so this resolves against the
  // OWNER rate card/template instead of AGENT's. assertPartnerNotOwnProperty
  // (3.17) is the hard backstop if a line still tries to pay that partner —
  // the fold below is what keeps prefill from hitting that error in the
  // first place, by not offering the line at all when it would only ever be
  // rejected.
  const listingSubType = lead.property?.partner?.partnerSubType || 'AGENT';
  const selfListed = listingSubType === 'AGENT' && !!lead.propertyId && await isSelfListedByAgent(lead.propertyId);
  const sellerType = selfListed ? 'OWNER' : listingSubType;
  // backend-work-still-open.md #3 — a free-text (propertyInterest-only)
  // lead has no property to pull a city from; lead.city is the only source
  // then. A real listing's own city always wins when there is one.
  const { card, source } = await resolveRateCard({
    propertyId: lead.propertyId, city: lead.property?.city || lead.city, sellerType,
  });

  // backend-gaps-frontend-integration.md #1 — no hardcoded JS fallback
  // number: "Admin sets every percentage" means null (not a guessed 2%/50%)
  // when neither a rate card nor this platform-level config exists.
  const [defaultFeePct, defaultPartnerShare] = await Promise.all([
    getConfigNumber(DEFAULT_FEE_PCT_KEY, null),
    getConfigNumber(DEFAULT_PARTNER_SHARE_PCT_KEY, null),
  ]);

  let feePct = card?.feePct ?? defaultFeePct;
  let lines = card?.lines?.length
    ? card.lines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct }))
    // Platform default shape: just the closing agent's share — no PLATFORM
    // line (see resolvePartnerLines above). Empty when no default is
    // configured either; there's nothing to pre-fill, not a guess.
    : defaultPartnerShare != null
      ? [{ payeeRole: 'CLOSING_AGENT', pct: defaultPartnerShare }]
      : [];

  // R21 — the template's LISTING_AGENT/CLOSING_AGENT line assumes whoever
  // ends up assigned is a genuine third party. When the lead has in fact
  // been assigned back to the self-listing agent themselves, that line
  // would always be refused at lock time — folded into PLATFORM instead,
  // the same shape a sale with no agent in the loop at all would have. A
  // *different* partner later assigned to close the deal is unaffected:
  // this only fires when the assignee IS the owner-of-record.
  if (selfListed && lead.assignedPartnerId && lead.assignedPartnerId === lead.property?.partnerId) {
    lines = foldSelfListedPartnerLines(lines);
  }

  const override = await resolveOverride(lead.assignedPartnerId, lead.propertyId);
  if (override) lines = applyPartnerShareOverride(lines, override.partnerSharePct);

  // R29 — this buyer was referred by an advisor; pre-fill their ADVISOR
  // line (no pct/flatAmountPaise — setLeadTerms's linesWithAdvisorDefault
  // looks up advisorStandardFeePaise, the same path a manually-added
  // advisor line without a rate already goes through) instead of requiring
  // admin to re-attach the same advisor by hand on every lead this buyer
  // generates. An explicit ADVISOR line already present (admin override,
  // or a different advisor named for this specific deal) always wins.
  const referral = await getActiveReferralForPhone(lead.buyerPhone);
  if (referral && !lines.some((l) => l.payeeRole === 'ADVISOR')) {
    lines = [...lines, { payeeRole: 'ADVISOR', payeeUserId: referral.advisorId }];
  }

  // backend-gaps-frontend-integration.md #1 — show the real headroom in the
  // preview too, not just after saving: admin should see whether these
  // lines even fit before committing to them.
  const dealPrice = lead.property?.price ?? null;
  const feeAmount = dealPrice && feePct ? round2((dealPrice * feePct) / 100) : null;
  const rates = await getGatewayRates();
  const { retainedAmount, platformPctOfFee } = computePlatformRetained(feeAmount, rates);
  const partnerTotal = feeAmount != null
    ? round2(lines.reduce((s, l) => s + (l.flatAmountPaise != null ? l.flatAmountPaise / 100 : round2((feeAmount * (l.pct || 0)) / 100)), 0))
    : null;

  return {
    leadId,
    sellerType,
    selfListed,
    referredByAdvisorId: referral?.advisorId ?? null,
    feePct,
    lines,
    dealPrice,
    feeAmount,
    platformRetained: retainedAmount,
    platformShareOfFee: platformPctOfFee,
    headroom: feeAmount != null ? round2(feeAmount - retainedAmount - partnerTotal) : null,
    resolvedFrom: override ? 'PARTNER_OVERRIDE' : source,
    rateCardId: card?.id ?? null,
    rateCardVersion: card?.version ?? null,
  };
}

// Rescale the ASSIGNED PARTNER's slices to a new total share. Unlike the
// pre-826a73c version, there is no PLATFORM line to recompute any more — R
// is independent of these lines entirely (see computePlatformRetained). A
// smaller partner total just means a bigger headroom, not a bigger
// platform cut.
//
// ADVISOR is deliberately excluded from the rescaling pool: a partner-share
// override changes what the assigned listing/closing partner is paid, never
// a separate advisor's flat, deal-specific fee. If an ADVISOR line is already
// present it passes through unchanged, and the override's partnerSharePct
// still applies only to LISTING_AGENT/CLOSING_AGENT.
function applyPartnerShareOverride(lines, partnerSharePct) {
  if (!(partnerSharePct >= 0 && partnerSharePct <= 100)) {
    throw new ApiError(400, 'partnerSharePct must be between 0 and 100');
  }
  const advisorLine = lines.find((l) => l.payeeRole === 'ADVISOR');
  const partnerLines = lines.filter((l) => ASSIGNED_PARTNER_ROLES.includes(l.payeeRole));
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
  if (advisorLine) out.push(advisorLine);
  return out;
}

// R21 — removes LISTING_AGENT/CLOSING_AGENT lines outright when the
// assignee is the property's own self-listing partner (3.17 would refuse
// them anyway). Unlike the pre-826a73c version, nothing absorbs their
// share — it isn't "platform margin", it's just unallocated headroom now.
// ADVISOR is left untouched, same reasoning as applyPartnerShareOverride
// above: an advisor's flat, deal-specific fee has nothing to do with
// whether the listing/closing partner happens to be the owner.
function foldSelfListedPartnerLines(lines) {
  return lines.filter((l) => !ASSIGNED_PARTNER_ROLES.includes(l.payeeRole));
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
      // R26 — otherwise invoiceLeadCommission/collectLeadCommission (which
      // return getLeadTerms(leadId) after writing these) silently drop them
      // from their own response despite the write having succeeded.
      invoiceUrl: true, invoicedAt: true, collectedAt: true,
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const lines = await prisma.leadCommissionLine.findMany({
    where: { leadId, version: lead.commissionVersion },
    orderBy: { payeeRole: 'asc' },
  });

  return { ...lead, lines, locked: !!lead.commissionLockedAt, amounts: computeAmounts(lead, lines) };
}

// fee = price * feePct; each partner line = fee * pct. Seller residual is
// derived. backend-gaps-frontend-integration.md #1 — platformRetained (R)
// comes from the lead's own stored snapshot (platformCommissionPct/
// commissionAmountPaise), not from a line; headroom (B - R - ΣPi) is
// returned here so every read of a lead's terms shows it, not just the
// moment it's set.
function computeAmounts(lead, lines) {
  const price = lead.dealPriceAtLock;
  if (!price || !lead.feePct) return null;
  const feeAmount = round2((price * lead.feePct) / 100);
  const byPayee = lines.map((l) => ({
    payeeRole: l.payeeRole,
    payeeUserId: l.payeeUserId ?? null,
    pct: l.pct,
    // ADVISOR's stored flatAmountPaise is the figure that was actually
    // agreed — shown exactly, rather than recomputed from pct and risking
    // a paise of rounding drift on display.
    amount: l.flatAmountPaise != null ? round2(l.flatAmountPaise / 100) : round2((feeAmount * l.pct) / 100),
    flatAmountPaise: l.flatAmountPaise ?? null,
  }));
  const partnerTotal = round2(byPayee.reduce((s, l) => s + l.amount, 0));
  // platformCommissionPct is % of the FEE (R/B), by definition, since
  // computePlatformRetained is the only thing that ever writes it now.
  const platformRetained = lead.commissionAmountPaise != null ? round2(lead.commissionAmountPaise / 100) : 0;
  return {
    dealPrice: price,
    feeAmount,
    sellerNet: round2(price - feeAmount),
    platformRetained,
    platformShareOfFee: lead.platformCommissionPct ?? 0,
    partnerTotal,
    headroom: round2(feeAmount - platformRetained - partnerTotal),
    byPayee,
  };
}

// Write (or rewrite) a lead's negotiated lines. Before lock this edits the
// current version in place; after lock it writes a NEW version, since the old
// one is the record of what was already agreed.
//
// `lines` never includes PLATFORM — its share (R) is computed independently
// by computePlatformRetained below, never submitted. An ADVISOR line may
// omit both pct and flatAmountPaise; when it does, their standard rate
// (User.advisorStandardFeePaise) is used.
async function setLeadTerms(leadId, { feePct, dealPrice, lines, note }, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, assignedPartnerId: true, commissionLockedAt: true, commissionVersion: true,
      feePct: true, dealPriceAtLock: true, property: { select: { price: true } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const effectiveFeePct = feePct ?? lead.feePct;
  if (!(effectiveFeePct > 0)) {
    throw new ApiError(400, 'feePct is required (no default could be resolved)', { code: 'FEE_PCT_REQUIRED' });
  }
  const effectivePrice = dealPrice ?? lead.dealPriceAtLock ?? lead.property?.price ?? null;
  const feeAmount = effectivePrice != null ? round2((effectivePrice * effectiveFeePct) / 100) : null;

  // A line that names neither pct nor flatAmountPaise is only legal for
  // ADVISOR, and only when that advisor has a standard rate on file — filled
  // in here, before the lines are resolved, so resolvePartnerLines never
  // has to know about user profiles.
  const linesWithAdvisorDefault = await Promise.all((lines || []).map(async (l) => {
    if (l.payeeRole !== 'ADVISOR' || l.pct != null || l.flatAmountPaise != null) return l;
    const advisor = await prisma.user.findUnique({ where: { id: l.payeeUserId }, select: { advisorStandardFeePaise: true, name: true } });
    if (!advisor?.advisorStandardFeePaise) {
      throw new ApiError(400,
        `This advisor has no standard rate set and none was given for this deal. `
        + 'Set advisorStandardFeePaise on their profile, or pass flatAmountPaise/pct explicitly.',
        { code: 'ADVISOR_RATE_REQUIRED' });
    }
    return { ...l, flatAmountPaise: advisor.advisorStandardFeePaise };
  }));

  const resolvedLines = resolvePartnerLines(linesWithAdvisorDefault, feeAmount);

  // backend-gaps-frontend-integration.md #1 — R, calculated from the real
  // gateway rates, never admin-entered. Refuse outright if the partner
  // lines plus R would exceed the fee itself — ΣPi + R > B.
  const rates = await getGatewayRates();
  const { retainedAmount, platformPctOfFee } = computePlatformRetained(feeAmount, rates);
  if (feeAmount != null) {
    const partnerTotal = round2(resolvedLines.reduce((s, l) => s + (l.flatAmountPaise != null ? l.flatAmountPaise / 100 : round2((feeAmount * l.pct) / 100)), 0));
    if (round2(partnerTotal + retainedAmount) > feeAmount + RUPEE_EPSILON) {
      throw new ApiError(400,
        `Partner shares (₹${partnerTotal}) plus the platform's retained cost-recovery amount `
        + `(₹${retainedAmount}) exceed the brokerage fee itself (₹${feeAmount}). Reduce one or more shares.`,
        { code: 'LINES_EXCEED_HEADROOM', partnerTotal, retainedAmount, feeAmount,
          headroom: round2(feeAmount - retainedAmount - partnerTotal) });
    }
  }

  const wasLocked = !!lead.commissionLockedAt;
  const version = wasLocked ? lead.commissionVersion + 1 : lead.commissionVersion;

  // Agent-never-earns-on-own-property (3.17): a partner must not be paid for
  // selling a listing they themselves own.
  await assertPartnerNotOwnProperty(leadId, resolvedLines);

  await prisma.$transaction([
    // Only the current unlocked version is replaced; superseded versions are
    // left in place as history.
    ...(wasLocked ? [] : [prisma.leadCommissionLine.deleteMany({ where: { leadId, version } })]),
    prisma.leadCommissionLine.createMany({
      data: resolvedLines.map((l) => ({
        leadId,
        payeeRole: l.payeeRole,
        // ASSIGNED_PARTNER_ROLES default to the lead's assigned partner.
        // ADVISOR never defaults — it is always a different, explicitly
        // named person, enforced by the validator requiring payeeUserId.
        payeeUserId: l.payeeUserId ?? (ASSIGNED_PARTNER_ROLES.includes(l.payeeRole) ? lead.assignedPartnerId : null),
        pct: l.pct,
        flatAmountPaise: l.flatAmountPaise ?? null,
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
        // backend-gaps-frontend-integration.md #1 — platformCommissionPct is
        // now R/B (platformPctOfFee), stored as a snapshot of the gateway
        // rates at the moment terms were set/revised, same as the rest of
        // this record. commissionAmountPaise is R itself, in paise.
        platformCommissionPct: platformPctOfFee,
        ...(feeAmount != null && { commissionAmountPaise: Math.round(retainedAmount * 100) }),
      },
    }),
  ]);

  await createAuditLog({
    adminId, action: wasLocked ? 'COMMISSION_REVISED' : 'COMMISSION_TERMS_SET',
    targetType: 'Lead', targetId: leadId,
    before: { version: lead.commissionVersion, feePct: lead.feePct },
    after: { version, feePct: effectiveFeePct, lines: resolvedLines, retainedAmount, note: note ?? null },
    ipAddress: ip,
  });

  return getLeadTerms(leadId);
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

  // R21 — the fold in previewTermsForLead strips the only partner line this
  // lead had (it would just be rejected by assertPartnerNotOwnProperty
  // anyway), which leaves nothing to prefill. That's a real "needs a human
  // decision" state, not a bug — surfaced here with the actual cause instead
  // of letting it fall through to setLeadTerms' generic "at least one line
  // is required", which doesn't say why there's no line to begin with.
  if (preview.selfListed && !preview.lines.length) {
    throw new ApiError(400,
      "This lead is assigned to the property's own self-listing partner, who cannot earn commission on their "
      + 'own listing. Assign a different partner to close this deal, then set commission terms.',
      { code: 'SELF_LISTED_NO_PARTNER_ASSIGNED' });
  }

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
  assertStoredLinesFitHeadroom(terms.lines, terms.amounts?.feeAmount ?? null, terms.amounts?.platformRetained ?? 0);

  const locked = await prisma.lead.update({
    where: { id: leadId },
    data: { commissionLockedAt: new Date() },
  });

  await createAuditLog({
    adminId, action: 'COMMISSION_LOCKED', targetType: 'Lead', targetId: leadId,
    after: { version: locked.commissionVersion, feePct: locked.feePct }, ipAddress: ip,
  });

  // R32 — every named partner payee (LISTING_AGENT/CLOSING_AGENT/ADVISOR)
  // finds out what they're actually earning once it's locked, not only on
  // request. Fired here specifically, not on every prefill/revision before
  // this — terms can churn while still unlocked, and notifying on each
  // revision would be noise for a figure that isn't final yet.
  const amountsByPayee = new Map((terms.amounts?.byPayee || []).map((a) => [`${a.payeeRole}:${a.payeeUserId}`, a]));
  for (const line of terms.lines) {
    if (!PARTNER_ROLES.includes(line.payeeRole) || !line.payeeUserId) continue;
    const amt = amountsByPayee.get(`${line.payeeRole}:${line.payeeUserId}`);
    await createNotification({
      userId: line.payeeUserId,
      title: 'Commission locked',
      message: amt?.amount != null
        ? `Your commission for this deal is locked at ₹${amt.amount.toLocaleString('en-IN')} (${line.pct}% of the fee).`
        : `Your commission for this deal is locked at ${line.pct}% of the fee.`,
      type: 'COMMISSION_LOCKED',
      linkUrl: '/partner/finance',
    });
  }

  return getLeadTerms(leadId);
}

// ─── R26 — owner success-fee payment record + receipt ───────────────────────
// PENDING → INVOICED → COLLECTED, with DISPUTED as an off-ramp from either.
// A simple payment receipt (confirms the amount and whether it's paid) —
// deliberately not a GST tax invoice (no GSTIN/HSN/CGST-SGST split); see
// lib/pdfReceipt.js. "The owner" here is whoever is actually on the hook for
// the fee — property.partnerId, which is the real owner for an OWNER
// listing and, after R21, also correctly resolves to the self-listing agent
// rather than a third party that doesn't exist.
async function invoiceLeadCommission(leadId, adminId, ip) {
  const terms = await getLeadTerms(leadId);
  if (!terms.commissionLockedAt) {
    throw new ApiError(400, 'Lock the commission terms before invoicing', { code: 'COMMISSION_NOT_LOCKED' });
  }
  if (terms.commissionStatus !== 'PENDING') {
    throw new ApiError(400, `Cannot invoice from status ${terms.commissionStatus}`, { code: 'INVALID_COMMISSION_STATUS' });
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      refCode: true,
      property: { select: { title: true, partnerId: true, partner: { select: { name: true, companyName: true } } } },
    },
  });

  const invoicedAt = new Date();
  const pdfBuffer = await buildCommissionReceiptPdf({
    refCode: lead.refCode,
    propertyTitle: lead.property?.title,
    payerName: lead.property?.partner?.companyName || lead.property?.partner?.name,
    feePct: terms.feePct,
    dealPrice: terms.dealPriceAtLock,
    feeAmount: terms.amounts?.feeAmount,
    invoicedAt,
    collectedAt: null,
  });
  const { url } = await s3Upload(pdfBuffer, 'receipts', `receipt-${leadId}.pdf`, 'application/pdf');

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { commissionStatus: 'INVOICED', invoiceUrl: url, invoicedAt },
  });

  if (lead.property?.partnerId) {
    await createNotification({
      userId: lead.property.partnerId,
      title: 'Success fee invoice issued',
      message: terms.amounts?.feeAmount != null
        ? `Your success fee of ₹${terms.amounts.feeAmount.toLocaleString('en-IN')} for "${lead.property.title}" is now due.`
        : `Your success fee for "${lead.property.title}" is now due.`,
      type: 'COMMISSION_INVOICED',
      linkUrl: url,
    });
  }

  await createAuditLog({
    adminId, action: 'COMMISSION_INVOICED', targetType: 'Lead', targetId: leadId,
    after: { invoiceUrl: url, invoicedAt }, ipAddress: ip,
  });

  return getLeadTerms(leadId);
}

async function collectLeadCommission(leadId, adminId, ip) {
  const terms = await getLeadTerms(leadId);
  if (terms.commissionStatus !== 'INVOICED') {
    throw new ApiError(400, `Cannot collect from status ${terms.commissionStatus}`, { code: 'INVALID_COMMISSION_STATUS' });
  }

  const collectedAt = new Date();
  await prisma.lead.update({ where: { id: leadId }, data: { commissionStatus: 'COLLECTED', collectedAt } });

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { property: { select: { title: true, partnerId: true } } },
  });
  if (lead.property?.partnerId) {
    await createNotification({
      userId: lead.property.partnerId,
      title: 'Success fee payment confirmed',
      message: `Your success fee payment for "${lead.property.title}" has been confirmed. Thank you.`,
      type: 'COMMISSION_COLLECTED',
      linkUrl: '/partner/listings',
    });
  }

  await createAuditLog({
    adminId, action: 'COMMISSION_COLLECTED', targetType: 'Lead', targetId: leadId,
    after: { collectedAt }, ipAddress: ip,
  });

  return getLeadTerms(leadId);
}

// A COLLECTED fee is already settled — disputing it needs a human to first
// decide whether to reverse that, not a status flip, so it's refused rather
// than silently reopening a closed payment. Re-disputing an already-DISPUTED
// one is refused too; the existing dispute is what gets updated/resolved,
// not replaced.
async function disputeLeadCommission(leadId, reason, adminId, ip) {
  const terms = await getLeadTerms(leadId);
  if (!['PENDING', 'INVOICED'].includes(terms.commissionStatus)) {
    throw new ApiError(400, `Cannot dispute from status ${terms.commissionStatus}`, { code: 'INVALID_COMMISSION_STATUS' });
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { adminNotes: true } });
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      commissionStatus: 'DISPUTED',
      adminNotes: `${lead.adminNotes ? `${lead.adminNotes} | ` : ''}[Commission disputed] ${reason}`,
    },
  });

  await createAuditLog({
    adminId, action: 'COMMISSION_DISPUTED', targetType: 'Lead', targetId: leadId,
    before: { status: terms.commissionStatus }, after: { status: 'DISPUTED', reason }, ipAddress: ip,
  });

  return getLeadTerms(leadId);
}

// backend-work-still-open.md #5 — the escrow fee-due page: owner success
// fees (R26) that have been INVOICED but not yet COLLECTED. Lives here
// (not escrow.service.js) since the underlying state is Lead.commissionStatus,
// not anything on EscrowTransaction — the admin route path is
// GET /admin/escrow/fees-due per the spec, but what it actually reads is
// this module's own data.
async function listFeesDue(skip, limit) {
  const where = { commissionStatus: 'INVOICED' };
  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where, skip, take: limit, orderBy: { invoicedAt: 'asc' },
      select: {
        id: true, refCode: true, buyerName: true, commissionStatus: true,
        feePct: true, dealPriceAtLock: true, commissionAmountPaise: true,
        invoiceUrl: true, invoicedAt: true,
        property: { select: { id: true, title: true, partnerId: true, partner: { select: { name: true, companyName: true } } } },
        feeReminders: { orderBy: { createdAt: 'desc' }, select: { id: true, sentByAdminId: true, createdAt: true } },
      },
    }),
    prisma.lead.count({ where }),
  ]);
  return { data: rows, total };
}

async function sendFeeReminder(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { commissionStatus: true, invoiceUrl: true, property: { select: { title: true, partnerId: true } } },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.commissionStatus !== 'INVOICED') {
    throw new ApiError(400, `Cannot send a fee reminder for commission status ${lead.commissionStatus}, not INVOICED`, {
      code: 'INVALID_COMMISSION_STATUS',
    });
  }
  if (!lead.property?.partnerId) {
    throw new ApiError(400, 'No one to remind — this lead has no resolvable property owner');
  }

  const reminder = await prisma.feeReminder.create({ data: { leadId, sentByAdminId: adminId } });

  await createNotification({
    userId: lead.property.partnerId,
    title: 'Success fee payment reminder',
    message: `Your success fee for "${lead.property.title}" is still due.`,
    type: 'COMMISSION_FEE_REMINDER',
    linkUrl: lead.invoiceUrl || '/partner/finance',
  });

  await createAuditLog({
    adminId, action: 'FEE_REMINDER_SENT', targetType: 'Lead', targetId: leadId,
    after: { reminderId: reminder.id }, ipAddress: ip,
  });

  return reminder;
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
  const resolvedLines = resolveRateCardLines(lines);
  if (!card.propertyId && !card.city) {
    throw new ApiError(400, 'A rate card needs either a propertyId or a city', { code: 'RATE_CARD_NEEDS_SCOPE' });
  }

  const created = await prisma.rateCard.create({
    data: {
      ...card,
      lastChangedByAdminId: adminId,
      lines: { create: resolvedLines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct })) },
    },
    include: { lines: true },
  });

  await createAuditLog({
    adminId, action: 'RATE_CARD_CREATED', targetType: 'RateCard', targetId: created.id,
    after: { sellerType: created.sellerType, feePct: created.feePct, lines: resolvedLines }, ipAddress: ip,
  });
  return created;
}

async function updateRateCard(id, data, adminId, ip) {
  const card = await prisma.rateCard.findUnique({ where: { id }, include: { lines: true } });
  if (!card) throw new ApiError(404, 'Rate card not found');

  const { lines, ...rest } = data;
  const resolvedLines = lines ? resolveRateCardLines(lines) : null;

  // Version bumps on every content edit, so a lead can record which version
  // it was pre-filled from. Already-locked leads are unaffected — they read
  // their own snapshot and never the card.
  const updated = await prisma.rateCard.update({
    where: { id },
    data: {
      ...rest,
      version: card.version + 1,
      lastChangedByAdminId: adminId,
      ...(resolvedLines ? { lines: { deleteMany: {}, create: resolvedLines.map((l) => ({ payeeRole: l.payeeRole, pct: l.pct })) } } : {}),
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
        select: { leadId: true, payeeRole: true, payeeUserId: true, pct: true, version: true },
      })
    : [];

  const perLead = leads.map((l) => {
    // Filtered by payeeUserId, not just "any partner-role line on this lead"
    // — a lead can also carry a separate ADVISOR line for a different
    // person, which must never be counted as this partner's own share.
    const mine = lineRows.filter((r) =>
      r.leadId === l.id && r.version === l.commissionVersion && r.payeeUserId === partnerId
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
  invoiceLeadCommission, collectLeadCommission, disputeLeadCommission,
  listFeesDue, sendFeeReminder,
  resolvePartnerLines, resolveRateCardLines, assertStoredLinesFitHeadroom,
  applyPartnerShareOverride, foldSelfListedPartnerLines, computeAmounts,
  getGatewayRates, computePlatformRetained,
  PAYEE_ROLES, PARTNER_ROLES, ASSIGNED_PARTNER_ROLES,
};
