'use strict';

// Moving the real leads from one database to another (the dev database to production at go-live). Pure logic only, so it is tested
// without a database; scripts/exportRealLeads.js and scripts/importRealLeads.js do the reading and writing.
//
// "Real" is decided conservatively: a Facebook or website lead that is not linked to anything in the old database (no buyer account,
// no partner, no escrow, no staff owner), whose name and email do not look like test data, and whose listing is not a test listing.
// Anything else stays behind: its links would point at rows that do not exist in production.

const FORMAT = 'realtydoor-real-leads/1';
const SOURCES = ['FACEBOOK', 'WEBSITE'];
const TEST_WORDS = /qa|mock|test|beta|e2e|sample|seed|dummy|demo/i;

// Every id-valued column of Lead (from prisma/schema/lead.prisma). propertyId is carried as the listing's slug; intakeIntegrationId is
// dropped (integrations are set up again in production with new ids); every other one must be empty for a lead to be exported.
const LINK_FIELDS = [
  'buyerId', 'addedByPartnerId', 'addedByAdminId', 'relatedLeadId', 'assignedPartnerId', 'ownerStaffId', 'projectId',
  'allocationLetterVerifiedBy', 'contactRevealedByPartnerId', 'droppedByAdminId', 'rateCardId',
];

const looksTest = (s) => TEST_WORDS.test(String(s || ''));

function whyNotReal(lead, { hasEscrow, propertyTitle }) {
  if (!SOURCES.includes(lead.source)) return `source ${lead.source}`;
  if (hasEscrow) return 'has an escrow payment';
  for (const f of LINK_FIELDS) if (lead[f]) return `linked (${f})`;
  if (!lead.propertyId) return 'no listing';
  if (looksTest(lead.buyerName) || looksTest(lead.buyerEmail)) return 'test-looking buyer';
  if (looksTest(propertyTitle)) return 'test listing';
  return null;
}

const metaLeadId = (lead) => lead?.intakeAnswers?.lead_id ? String(lead.intakeAnswers.lead_id) : null;

function toRecord(lead, propertySlug) {
  const { id: _id, propertyId: _p, intakeIntegrationId: _i, updatedAt: _u, ...rest } = lead;
  for (const f of LINK_FIELDS) delete rest[f];
  return { ...rest, propertySlug };
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
function fromRecord(record, propertyId) {
  const { propertySlug: _s, ...rest } = record;
  const data = {};
  for (const [k, v] of Object.entries(rest)) data[k] = typeof v === 'string' && ISO.test(v) ? new Date(v) : v;
  return { ...data, propertyId };
}

const refNumber = (refCode) => { const m = /^RD-L-(\d+)$/.exec(String(refCode || '')); return m ? Number(m[1]) : 0; };

// What would an import do? A record is skipped when its ref code or its Meta lead id is already in the target (so running it twice is
// harmless), when its listing slug does not exist in the target, or when it is not a valid record.
// allowUnlisted: a lead whose listing is not in the target is still added, with no listing link; its project slug is kept in brackets in
// propertyInterest ("Vrunda City [vrunda-city-gated-plots-hoskote]") so scripts/attachLeadsToListings.js can link it once the listing exists.
function planImport(records, { existingRefCodes = new Set(), existingMetaIds = new Set(), listingsBySlug = new Map(), allowUnlisted = false } = {}) {
  const toCreate = [];
  const skipped = [];
  const seenRef = new Set();
  const seenMeta = new Set();
  for (const r of records) {
    const label = r?.refCode || `${r?.buyerName || '?'}`;
    if (!r || typeof r !== 'object' || !r.buyerPhone || !r.propertySlug) { skipped.push({ label, reason: 'not a valid record' }); continue; }
    const meta = metaLeadId(r);
    if (r.refCode && (existingRefCodes.has(r.refCode) || seenRef.has(r.refCode))) { skipped.push({ label, reason: 'already in the target (ref code)' }); continue; }
    if (meta && (existingMetaIds.has(meta) || seenMeta.has(meta))) { skipped.push({ label, reason: 'already in the target (Meta lead id)' }); continue; }
    const listing = listingsBySlug.get(r.propertySlug);
    if (!listing && !allowUnlisted) { skipped.push({ label, reason: `listing "${r.propertySlug}" is not in the target` }); continue; }
    if (r.refCode) seenRef.add(r.refCode);
    if (meta) seenMeta.add(meta);
    if (listing) { toCreate.push({ record: r, data: fromRecord(r, listing.id) }); continue; }
    const data = fromRecord(r, null);
    data.propertyInterest = `${String(r.propertyInterest || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim() || r.propertySlug} [${r.propertySlug}]`;
    toCreate.push({ record: r, data, unlisted: true });
  }
  const maxRef = records.reduce((m, r) => Math.max(m, refNumber(r?.refCode)), 0);
  return { toCreate, skipped, maxRef };
}

module.exports = { FORMAT, SOURCES, LINK_FIELDS, looksTest, whyNotReal, metaLeadId, toRecord, fromRecord, refNumber, planImport };
