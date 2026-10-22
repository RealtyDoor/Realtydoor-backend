// Planning for scripts/dataCleanup.js: pure functions over rows already read from the database, so the rules can be
// tested without one. Nothing here writes anything.

const PLACEHOLDER_TEXT = 'Upload available once the backend accepts document types';
const JUNK_PARTNER_TICKETS = ['SUP-0009', 'SUP-0010'];
const JUNK_USER_TICKET_SUBJECTS = ['iojqoiew'];

// B51 — legacy rows were saved as PLOT whatever they were. The title usually says what the listing is.
function guessPropertyType(title) {
  const t = String(title || '').toLowerCase();
  if (/\bvilla\b/.test(t)) return 'VILLA';
  if (/\b(independent house|house)\b/.test(t)) return 'INDEPENDENT_HOUSE';
  if (/\b\d+\s*bhk\b|\bapartment\b|\bflat\b/.test(t)) return 'FLAT';
  return null;
}

// B51 — only a PLOT whose title clearly says something else is proposed for change.
function planPropertyTypeFixes(properties) {
  return properties
    .filter((p) => p.propertyType === 'PLOT')
    .map((p) => ({ id: p.id, title: p.title, from: 'PLOT', to: guessPropertyType(p.title) }))
    .filter((f) => f.to && f.to !== 'PLOT');
}

// T41 — a QA / retest service still active in the real catalog.
const isQaService = (s) => !!s.isActive && /^qa\b|retest/i.test(String(s.name || ''));
const planQaServices = (services) => services.filter(isQaService).map((s) => ({ id: s.id, name: s.name, price: s.price }));

// T19, B46 — known junk tickets are closed, never deleted.
function planJunkTickets({ partnerTickets = [], userTickets = [] }) {
  return {
    partner: partnerTickets.filter((t) => JUNK_PARTNER_TICKETS.includes(t.ticketNo) && t.status !== 'CLOSED').map((t) => ({ id: t.id, ticketNo: t.ticketNo, subject: t.subject })),
    user: userTickets.filter((t) => JUNK_USER_TICKET_SUBJECTS.includes(String(t.subject || '').trim().toLowerCase()) && t.status !== 'CLOSED').map((t) => ({ id: t.id, subject: t.subject })),
  };
}

// Report only: these need the owner's decision, so the script never changes them.
const findOrphanedProperties = (properties, partnerIds) => {
  const known = new Set(partnerIds);
  return properties.filter((p) => !known.has(p.partnerId)).map((p) => ({ id: p.id, title: p.title, partnerId: p.partnerId, publishStatus: p.publishStatus }));
};
// T4 — a rent of ten lakh a month or more is almost certainly a sale price typed into the rent field.
const findSuspiciousRents = (properties) => properties
  .filter((p) => p.listingType === 'RENT' && p.monthlyRent >= 1000000)
  .map((p) => ({ id: p.id, title: p.title, monthlyRent: p.monthlyRent }));
// T5 — the form hint text that once got saved as a description.
const findPlaceholderDescriptions = (properties) => properties
  .filter((p) => String(p.description || '').includes(PLACEHOLDER_TEXT))
  .map((p) => ({ id: p.id, title: p.title }));

module.exports = {
  PLACEHOLDER_TEXT, JUNK_PARTNER_TICKETS, JUNK_USER_TICKET_SUBJECTS,
  guessPropertyType, planPropertyTypeFixes, isQaService, planQaServices, planJunkTickets,
  findOrphanedProperties, findSuspiciousRents, findPlaceholderDescriptions,
};
