/**
 * Populates every state, status and edge case introduced in this session's
 * commits (listing change requests, mandates/conflicts, location, visibility/
 * request-changes, the persona checklist, owner confirmation, KYC document
 * requests, escrow freeze, data acknowledgments, auto-assign) so a frontend
 * engineer can hit a real, documented record for each one instead of guessing
 * from the API docs alone.
 *
 * Deliberately goes through the real service functions (propSvc.createProperty,
 * adminSvc.approveProperty, integritySvc.createMandate, checklistSvc.*,
 * listingsAdminSvc.*, locationSvc.updateLocation, escrowSvc.freeze, ...)
 * rather than writing rows by hand — the point is that this data is byte for
 * byte what the real flow produces, not a hand-rolled approximation that
 * could quietly diverge from actual validation.
 *
 * Every created user/property/lead is clearly marked (email domain
 * @mockqa.test, titles prefixed "MOCK QA —") so it is never mistaken for real
 * data, and no existing record is ever mutated — this never repeats the
 * mistake an earlier test run made of touching real partners or real leads.
 *
 * Idempotent at the top level only: if the first mock user already exists,
 * the whole script exits without doing anything, on the assumption a partial
 * second run is more likely to create confusing duplicates than a clean one.
 * Delete rows matching @mockqa.test / "MOCK QA" by hand to start over.
 *
 *   node scripts/seedMockStates.js
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');

const propSvc = require('../src/modules/properties/properties.service');
const adminSvc = require('../src/modules/admin/admin.service');
const integritySvc = require('../src/modules/listings/integrity.service');
const listingsAdminSvc = require('../src/modules/listings/listings.admin.service');
const checklistSvc = require('../src/modules/listings/checklist.service');
const locationSvc = require('../src/modules/listings/location.service');
const escrowSvc = require('../src/modules/escrow/escrow.service');
const dataAckSvc = require('../src/modules/partners/dataAck.service');
const { nextRefCode } = require('../src/lib/refCode');

const DAY = 86400000;
const index = {}; // what this run created, printed at the end and used to write MOCK_DATA.md

async function main() {
  const existing = await prisma.user.findFirst({ where: { email: 'mockqa.owner.verified@mockqa.test' } });
  if (existing) {
    console.log('Mock data already seeded (mockqa.owner.verified@mockqa.test exists). Nothing to do.');
    console.log('Delete rows matching @mockqa.test / "MOCK QA" by hand to re-seed.');
    process.exit(0);
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) throw new Error('No ADMIN user found — run prisma/seed.js first');

  // ─── Mock partners ──────────────────────────────────────────────────────
  async function makePartner(emailLocal, name, subType, kyc = {}) {
    const user = await prisma.user.create({
      data: {
        // clerkId is required + unique on User — a fixed, obviously-fake,
        // per-fixture value, never a real Clerk id. refCode is likewise
        // required-in-practice (@unique, assigned by application code at
        // creation, not a Prisma default) — every normal signup path calls
        // this, and skipping it here collided every user after the first on
        // a shared null.
        clerkId: `mockqa_${emailLocal.replace(/\./g, '_')}`,
        refCode: await nextRefCode('user'),
        email: `${emailLocal}@mockqa.test`, name, role: 'PARTNER',
        phone: '+91900' + String(Math.floor(1000000 + Math.random() * 8999999)),
        phoneVerified: true, partnerSubType: subType,
        kycStatus: kyc.status || 'VERIFIED', kycVerifiedAt: kyc.status === 'VERIFIED' ? new Date() : null,
        kycConsentAt: new Date(),
        panNumber: kyc.panNumber || null,
        ...kyc.extra,
      },
    });
    index[emailLocal] = { id: user.id, name, email: user.email };
    return user;
  }

  const ownerVerified = await makePartner('mockqa.owner.verified', 'Mock QA Owner — Verified', 'OWNER');
  const ownerChecklist = await makePartner('mockqa.owner.checklist', 'Mock QA Owner — Checklist Mix', 'OWNER');
  const agent = await makePartner('mockqa.agent', 'Mock QA Agent', 'AGENT');
  const agentSelfDeal = await makePartner('mockqa.agent.selfdeal', 'Mock QA Agent — Self-Dealing', 'AGENT', { panNumber: 'SELFD1234F' });
  const builder = await makePartner('mockqa.builder', 'Mock QA Builder', 'BUILDER');
  const kycDocsRequested = await makePartner('mockqa.kyc.docsrequested', 'Mock QA — KYC Docs Requested', 'AGENT', { status: 'PENDING_REVIEW' });
  const kycOverdue = await makePartner('mockqa.kyc.overdue', 'Mock QA — KYC Overdue', 'AGENT', { status: 'PENDING_REVIEW' });
  const autoReady = await makePartner('mockqa.autoassign.ready', 'Mock QA — Auto-Assign Ready', 'AGENT', {
    extra: { leadAutoAccept: true, leadPauseOverloaded: false, leadPreferredLocalities: ['MockQA Layout'] },
  });
  const autoPaused = await makePartner('mockqa.autoassign.paused', 'Mock QA — Auto-Assign Paused', 'AGENT', {
    extra: { leadAutoAccept: true, leadPauseOverloaded: true, leadPreferredLocalities: ['MockQA Layout'] },
  });
  const noAck = await makePartner('mockqa.dataack.none', 'Mock QA — No Acknowledgments', 'AGENT');

  console.log('Created 10 mock partners.');

  // ─── Properties ──────────────────────────────────────────────────────────
  const baseProp = {
    description: 'Mock QA fixture property — created by scripts/seedMockStates.js, safe to ignore or delete.',
    price: 7500000, propertyType: 'FLAT', listingType: 'SALE',
    locality: 'MockQA Layout', city: 'Pune', state: 'Maharashtra', pincode: '411099', bhk: 2,
  };

  async function makeApprovedProperty(partner, title, extra = {}, visibility = {}) {
    const p = await propSvc.createProperty({ ...baseProp, title: `MOCK QA — ${title}`, address: `${title}, MockQA Layout`, ...extra }, partner.id);
    await adminSvc.approveProperty(p.id, admin.id, '127.0.0.1', visibility);
    return prisma.property.findUnique({ where: { id: p.id } });
  }

  // 1. Location check states ------------------------------------------------
  const locClean = await makeApprovedProperty(ownerVerified, 'Location Clean (verified)');
  await locationSvc.updateLocation(locClean.id, { reason: 'Mock QA seed: verified clean', mapLink: 'https://www.google.com/maps/@18.5000,73.9000,17z' }, { adminId: admin.id, adminName: admin.name }, '127.0.0.1');

  const locMismatch = await makeApprovedProperty(ownerVerified, 'Location Pin/Map Mismatch', {
    mapLink: 'https://www.google.com/maps/@18.5000,73.9000,17z',
    partnerPinLatitude: 18.5300, partnerPinLongitude: 73.9000, // ~3.3km off — well over the 300m default tolerance
  });

  const locUnparseable = await makeApprovedProperty(ownerVerified, 'Location Unparseable Link', { mapLink: 'https://maps.app.goo.gl/MockQAShortLink' });

  const locBare = await propSvc.createProperty({ ...baseProp, title: 'MOCK QA — Location Bare (no evidence)', address: 'Bare Block, MockQA Layout' }, ownerVerified.id);
  await adminSvc.approveProperty(locBare.id, admin.id, '127.0.0.1');

  index.location = {
    clean: locClean.id, mismatch: locMismatch.id, unparseable: locUnparseable.id, bare: locBare.id,
  };
  console.log('Location check: 4 properties (clean, mismatch, unparseable link, no evidence at all).');

  // 2. Visibility states -----------------------------------------------------
  const visDefault = await makeApprovedProperty(ownerVerified, 'Visibility Default (public+search)');
  const visUnlisted = await makeApprovedProperty(ownerVerified, 'Visibility Unlisted (public by link only)', {}, { searchable: false });
  const visFeatured = await makeApprovedProperty(ownerVerified, 'Visibility Featured', {}, { searchable: true, homepageFeatured: true });

  const visChangesRequested = await propSvc.createProperty({ ...baseProp, title: 'MOCK QA — Changes Requested', address: 'Changes Block, MockQA Layout' }, ownerVerified.id);
  await adminSvc.requestPropertyChanges(visChangesRequested.id, {
    items: ['Add at least 3 interior photos', 'Carpet area looks too low for a 2BHK — double-check', 'RERA number missing'],
    note: 'Resend once these are fixed and it goes straight back into the queue.',
  }, admin.id, admin.name, '127.0.0.1');

  index.visibility = { default: visDefault.id, unlisted: visUnlisted.id, featured: visFeatured.id, changesRequested: visChangesRequested.id };
  console.log('Visibility: 4 properties (default, unlisted, featured, CHANGES_REQUESTED with a 3-item checklist).');

  // 3. Mortgage / loan NOC ----------------------------------------------------
  const mortgaged = await makeApprovedProperty(ownerVerified, 'Mortgaged, Loan NOC Pending', { isMortgaged: true, mortgageLender: 'HDFC Bank', loanNocStatus: 'PENDING' });
  index.mortgage = { pending: mortgaged.id };
  console.log('Mortgage: 1 property (isMortgaged=true, loanNocStatus=PENDING).');

  // 4. Owner persona checklist — the full state mix --------------------------
  const checklistProp = await makeApprovedProperty(ownerChecklist, 'Owner Checklist Mix');
  async function fakeFile(name) { return { path: `https://files.mockqa.test/${name}`, originalname: name }; }

  const saleDeed = await checklistSvc.uploadChecklistDocument(checklistProp.id, ownerChecklist.id, { documentType: 'SALE_DEED', file: await fakeFile('sale-deed.pdf') });
  await checklistSvc.verifyChecklistDocument(saleDeed.id, admin.id, '127.0.0.1'); // -> APPROVED

  await checklistSvc.uploadChecklistDocument(checklistProp.id, ownerChecklist.id, { documentType: 'ENCUMBRANCE_CERTIFICATE', file: await fakeFile('ec.pdf') }); // -> PENDING_REVIEW, left as is

  const khata = await checklistSvc.uploadChecklistDocument(checklistProp.id, ownerChecklist.id, { documentType: 'KHATA', file: await fakeFile('khata-v1.pdf') });
  await checklistSvc.rejectChecklistDocument(khata.id, 'Scanned copy is unreadable, resend a clearer scan', admin.id, '127.0.0.1'); // -> REJECTED
  // SOCIETY_NOC: left untouched -> reads as MISSING

  index.checklist = { property: checklistProp.id, partner: ownerChecklist.id };
  console.log('Checklist: 1 property with all 4 owner documents in a different status (APPROVED/PENDING_REVIEW/REJECTED/MISSING).');

  // 5. Mandates + owner confirmation — the full state mix --------------------
  async function propForAgent(title) {
    const p = await propSvc.createProperty({ ...baseProp, title: `MOCK QA — ${title}`, address: `${title}, MockQA Layout` }, agent.id);
    await adminSvc.approveProperty(p.id, admin.id, '127.0.0.1');
    return p;
  }

  // 5a. Mandate ACTIVE + OwnerConfirmation PENDING (fresh, not due)
  const pConfPending = await propForAgent('Mandate — Confirmation Pending');
  const mPending = await integritySvc.createMandate(pConfPending.id, {
    ownerName: 'Ramesh Pending', ownerPhone: '+919800000001',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 90 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  const confPending = await checklistSvc.requestOwnerConfirmation(pConfPending.id, mPending.mandate.id, { requestedVia: 'Phone call' }, admin.id);

  // 5b. Mandate ACTIVE + OwnerConfirmation CONFIRMED
  const pConfConfirmed = await propForAgent('Mandate — Confirmation Confirmed');
  const mConfirmed = await integritySvc.createMandate(pConfConfirmed.id, {
    ownerName: 'Sunita Confirmed', ownerPhone: '+919800000002',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 90 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  const confConfirmed = await checklistSvc.requestOwnerConfirmation(pConfConfirmed.id, mConfirmed.mandate.id, { requestedVia: 'WhatsApp' }, admin.id);
  await checklistSvc.recordOwnerConfirmationResponse(confConfirmed.id, { status: 'CONFIRMED', note: 'Called the owner directly; they confirmed the agent is authorized.' }, admin.id, '127.0.0.1');

  // 5c. Mandate ACTIVE + OwnerConfirmation DENIED -> raises OWNER_DENIED_MANDATE conflict
  const pConfDenied = await propForAgent('Mandate — Confirmation Denied');
  const mDenied = await integritySvc.createMandate(pConfDenied.id, {
    ownerName: 'Vikram Denied', ownerPhone: '+919800000003',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 90 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  const confDenied = await checklistSvc.requestOwnerConfirmation(pConfDenied.id, mDenied.mandate.id, { requestedVia: 'Phone call' }, admin.id);
  await checklistSvc.recordOwnerConfirmationResponse(confDenied.id, { status: 'DENIED', note: 'Owner says they never authorized this agent to list the property.' }, admin.id, '127.0.0.1');

  // 5d. OwnerConfirmation PENDING but past its 48h deadline -> reads as TIMED_OUT
  const pConfTimedOut = await propForAgent('Mandate — Confirmation Timed Out');
  const mTimedOut = await integritySvc.createMandate(pConfTimedOut.id, {
    ownerName: 'Late Owner', ownerPhone: '+919800000004',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 90 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  const confTimedOut = await checklistSvc.requestOwnerConfirmation(pConfTimedOut.id, mTimedOut.mandate.id, { requestedVia: 'Phone call' }, admin.id);
  await prisma.ownerConfirmation.update({ where: { id: confTimedOut.id }, data: { requestedAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) } });

  // 5e. A second request on the same mandate -> first SUPERSEDED, second PENDING
  const pConfSuperseded = await propForAgent('Mandate — Confirmation Superseded');
  const mSuperseded = await integritySvc.createMandate(pConfSuperseded.id, {
    ownerName: 'Twice Asked Owner', ownerPhone: '+919800000005',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 90 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  await checklistSvc.requestOwnerConfirmation(pConfSuperseded.id, mSuperseded.mandate.id, { requestedVia: 'Phone call, no answer' }, admin.id);
  const confSupersededLatest = await checklistSvc.requestOwnerConfirmation(pConfSuperseded.id, mSuperseded.mandate.id, { requestedVia: 'WhatsApp, this time' }, admin.id);

  // 5f. A REVOKED mandate
  const pMandateRevoked = await propForAgent('Mandate — Revoked');
  const mToRevoke = await integritySvc.createMandate(pMandateRevoked.id, {
    ownerName: 'Withdrawn Owner', ownerPhone: '+919800000006',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 30 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');
  await integritySvc.revokeMandate(mToRevoke.mandate.id, 'Owner withdrew from the market', admin.id, '127.0.0.1');

  // 5g. An EXPIRED mandate (derived — stored status stays ACTIVE)
  const pMandateExpired = await propForAgent('Mandate — Expired');
  const mExpired = await integritySvc.createMandate(pMandateExpired.id, {
    ownerName: 'Past Owner', ownerPhone: '+919800000007',
    startDate: new Date(Date.now() - 60 * DAY).toISOString(), expiryDate: new Date(Date.now() - 5 * DAY).toISOString(),
  }, admin.id, '127.0.0.1');

  // 5h. Agent self-dealing -> AGENT_OWNER_PAN_MATCH conflict (auto-raised)
  const pSelfDealReal = await (async () => {
    const p = await propSvc.createProperty({ ...baseProp, title: 'MOCK QA — Agent Self-Dealing', address: 'Self-Deal Block, MockQA Layout' }, agentSelfDeal.id);
    await adminSvc.approveProperty(p.id, admin.id, '127.0.0.1');
    return p;
  })();
  const mSelfDeal = await integritySvc.createMandate(pSelfDealReal.id, {
    ownerName: 'Suspiciously Convenient Owner', ownerPhone: '+919800000008', ownerPan: 'selfd1234f',
    startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 30 * DAY).toISOString(),
    partnerId: agentSelfDeal.id,
  }, admin.id, '127.0.0.1');

  index.mandates = {
    confirmationPending: { property: pConfPending.id, mandate: mPending.mandate.id, confirmation: confPending.id },
    confirmationConfirmed: { property: pConfConfirmed.id, mandate: mConfirmed.mandate.id, confirmation: confConfirmed.id },
    confirmationDenied: { property: pConfDenied.id, mandate: mDenied.mandate.id, confirmation: confDenied.id },
    confirmationTimedOut: { property: pConfTimedOut.id, mandate: mTimedOut.mandate.id, confirmation: confTimedOut.id },
    confirmationSuperseded: { property: pConfSuperseded.id, mandate: mSuperseded.mandate.id, latestConfirmation: confSupersededLatest.id },
    revoked: { property: pMandateRevoked.id, mandate: mToRevoke.mandate.id },
    expired: { property: pMandateExpired.id, mandate: mExpired.mandate.id },
    selfDealing: { property: pSelfDealReal.id, mandate: mSelfDeal.mandate.id, partner: agentSelfDeal.id },
  };
  console.log('Mandates/owner confirmation: 8 properties covering PENDING/CONFIRMED/DENIED/TIMED_OUT/SUPERSEDED/REVOKED/EXPIRED + self-dealing.');

  // 6. Listing conflicts — DUPLICATE_UNIT + MANDATE_OVERLAP, one of each resolution --
  async function propAt(partner, title, addressOverride) {
    const p = await propSvc.createProperty({ ...baseProp, title: `MOCK QA — ${title}`, address: addressOverride }, partner.id);
    await adminSvc.approveProperty(p.id, admin.id, '127.0.0.1');
    return p;
  }

  // 6a. DUPLICATE_UNIT, left OPEN
  const dupOpenA = await propAt(ownerVerified, 'Duplicate Unit A (open)', 'Flat 501, Tower Z, MockQA Layout');
  const dupOpenB = await propAt(agent, 'Duplicate Unit B (open)', '501 Tower-Z MockQA Layout');

  // 6b. DUPLICATE_UNIT, then DISMISSED
  const dupDismissA = await propAt(ownerVerified, 'Duplicate Unit A (dismissed)', 'Flat 502, Tower Z, MockQA Layout');
  const dupDismissB = await propAt(agent, 'Duplicate Unit B (dismissed)', '502 Tower-Z MockQA Layout');
  const dupDismissConflicts = await integritySvc.listConflicts({ propertyId: dupDismissB.id, type: 'DUPLICATE_UNIT' }, 0, 5);
  let dupDismissedConflictId = null;
  if (dupDismissConflicts.data[0]) {
    const dismissed = await integritySvc.resolveConflict(dupDismissConflicts.data[0].id, { status: 'DISMISSED', resolution: 'Different units; the address text omitted the unit number. Confirmed by calling both partners.', adminId: admin.id }, '127.0.0.1');
    dupDismissedConflictId = dismissed.id;
  }

  // 6c. MANDATE_OVERLAP (two different partners, mandates on the same keyed
  //     unit), then RESOLVED
  const ovlA = await propAt(ownerVerified, 'Mandate Overlap A (resolved)', 'Flat 503, Tower Z, MockQA Layout');
  const ovlB = await propAt(agent, 'Mandate Overlap B (resolved)', '503 Tower-Z MockQA Layout');
  await integritySvc.createMandate(ovlA.id, { ownerName: 'Overlap Owner One', ownerPhone: '+919800000009', startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 30 * DAY).toISOString() }, admin.id, '127.0.0.1');
  await integritySvc.createMandate(ovlB.id, { ownerName: 'Overlap Owner Two', ownerPhone: '+919800000010', startDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 30 * DAY).toISOString(), partnerId: agent.id }, admin.id, '127.0.0.1');
  const overlapConflicts = await integritySvc.listConflicts({ propertyId: ovlB.id, type: 'MANDATE_OVERLAP' }, 0, 5);
  let overlapResolvedId = null;
  if (overlapConflicts.data[0]) {
    const resolved = await integritySvc.resolveConflict(overlapConflicts.data[0].id, { status: 'RESOLVED', resolution: 'Admin called both partners; owner confirmed only the first mandate is genuine, the second was revoked.', adminId: admin.id }, '127.0.0.1');
    overlapResolvedId = resolved.id;
  }

  index.conflicts = {
    duplicateOpen: { a: dupOpenA.id, b: dupOpenB.id },
    duplicateDismissed: { a: dupDismissA.id, b: dupDismissB.id, conflictId: dupDismissedConflictId },
    mandateOverlapResolved: { a: ovlA.id, b: ovlB.id, conflictId: overlapResolvedId },
    agentOwnerPanMatchOpen: pSelfDealReal.id, // from section 5h
    ownerDeniedMandateOpen: pConfDenied.id,   // from section 5c
  };
  console.log('Conflicts: DUPLICATE_UNIT (open + dismissed), MANDATE_OVERLAP (resolved), AGENT_OWNER_PAN_MATCH (open), OWNER_DENIED_MANDATE (open).');

  // 7. Change requests — PENDING / conflicted / APPROVED / REJECTED / SUPERSEDED --
  const crPending = await makeApprovedProperty(ownerVerified, 'Change Request Pending');
  await propSvc.updateProperty(crPending.id, ownerVerified.id, { price: 8200000, amenities: ['Lift', 'Power Backup'] });

  const crConflict = await makeApprovedProperty(ownerVerified, 'Change Request Conflict');
  const crConflictResult = await propSvc.updateProperty(crConflict.id, ownerVerified.id, { price: 8500000 });
  // Admin edits the SAME field afterwards, so the stored diff no longer
  // matches — the detail view's conflicts[] will be non-empty.
  await prisma.property.update({ where: { id: crConflict.id }, data: { price: 7900000 } });

  const crApproved = await makeApprovedProperty(ownerVerified, 'Change Request Approved');
  const crApprovedResult = await propSvc.updateProperty(crApproved.id, ownerVerified.id, { price: 8100000 });
  await listingsAdminSvc.approveChangeRequest(crApprovedResult.changeRequest.id, { adminId: admin.id, adminName: admin.name, note: 'Looks correct.' }, '127.0.0.1');

  const crRejected = await makeApprovedProperty(ownerVerified, 'Change Request Rejected');
  const crRejectedResult = await propSvc.updateProperty(crRejected.id, ownerVerified.id, { price: 50000 });
  await listingsAdminSvc.rejectChangeRequest(crRejectedResult.changeRequest.id, { adminId: admin.id, note: 'Price looks like a typo — confirm the actual figure and resend.' }, '127.0.0.1');

  const crSuperseded = await makeApprovedProperty(ownerVerified, 'Change Request Superseded');
  const crSupersededFirst = await propSvc.updateProperty(crSuperseded.id, ownerVerified.id, { price: 8300000 });
  const crSupersededLatest = await propSvc.updateProperty(crSuperseded.id, ownerVerified.id, { price: 8400000 });

  index.changeRequests = {
    pending: { property: crPending.id },
    conflict: { property: crConflict.id, changeRequestId: crConflictResult.changeRequest.id },
    approved: { property: crApproved.id, changeRequestId: crApprovedResult.changeRequest.id },
    rejected: { property: crRejected.id, changeRequestId: crRejectedResult.changeRequest.id },
    superseded: { property: crSuperseded.id, supersededId: crSupersededFirst.changeRequest.id, latestId: crSupersededLatest.changeRequest.id },
  };
  console.log('Change requests: 5 properties (PENDING, conflicted, APPROVED, REJECTED, SUPERSEDED).');

  // 8. KYC document requests --------------------------------------------------
  await adminSvc.requestKycDocuments(kycDocsRequested.id, {
    items: ['PAN card is blurry, reupload', 'Missing latest bank statement'],
    note: 'Resend once these are fixed and it goes straight back into review.',
    dueInDays: 3,
  }, admin.id, '127.0.0.1');

  await adminSvc.requestKycDocuments(kycOverdue.id, {
    items: ['RERA registration certificate is expired'],
    note: 'Cannot verify KYC until this is renewed and reuploaded.',
    dueInDays: 3,
  }, admin.id, '127.0.0.1');
  await prisma.user.update({ where: { id: kycOverdue.id }, data: { kycRequestedDueAt: new Date(Date.now() - 2 * DAY) } });

  index.kyc = { docsRequested: kycDocsRequested.id, overdue: kycOverdue.id };
  console.log('KYC: 2 partners (DOCUMENTS_REQUESTED, and one past its due date -> reads as DOCUMENTS_REQUESTED_OVERDUE).');

  // 9. Escrow freeze -----------------------------------------------------------
  // Direct row, not createOrder()/confirmPayment() — those call the real
  // Razorpay API. freeze() itself is a pure DB operation (no Razorpay call),
  // so a directly-created HELD row is a faithful fixture for it, the same
  // way prisma/seed.js creates its own escrow rows directly.
  const escrowBuyer = await prisma.user.create({
    data: {
      clerkId: 'mockqa_escrow_buyer',
      refCode: await nextRefCode('user'),
      email: 'mockqa.escrow.buyer@mockqa.test', name: 'Mock QA Escrow Buyer', role: 'USER',
      phone: '+919800000099', phoneVerified: true,
    },
  });
  const escrowLead = await prisma.lead.create({
    data: {
      refCode: 'L-MOCKQA-ESCROW', buyerName: 'Mock QA Escrow Buyer', buyerPhone: '+919800000099',
      buyerEmail: 'mockqa.escrow.buyer@mockqa.test', buyerId: escrowBuyer.id, propertyId: visDefault.id,
      status: 'SITE_VISIT_DONE', assignedPartnerId: ownerVerified.id, isOtpVerified: true,
    },
  });
  const frozenEscrow = await prisma.escrowTransaction.create({
    data: {
      leadId: escrowLead.id, buyerId: escrowBuyer.id, razorpayOrderId: 'order_mockqa_frozen_001',
      razorpayPaymentId: 'pay_mockqa_frozen_001', amount: 250000, status: 'HELD', heldAt: new Date(),
    },
  });
  await escrowSvc.freeze(frozenEscrow.id, 'Buyer disputes the deal terms, pending admin review (mock QA fixture).', admin.id, '127.0.0.1');

  index.escrow = { frozenId: frozenEscrow.id, leadId: escrowLead.id };
  console.log('Escrow: 1 FROZEN escrow, with a real reason and audit entry.');

  // 10. Auto-assign — a ready target, a paused decoy, and a live UNASSIGNED lead --
  const autoAssignProp = await propAt(ownerVerified, 'Auto-Assign Target', 'Ready Block, MockQA Layout');
  const autoAssignLead = await prisma.lead.create({
    data: {
      refCode: 'L-MOCKQA-AUTOASSIGN', buyerName: 'Mock QA Auto-Assign Buyer', buyerPhone: '+919800000098',
      buyerEmail: 'mockqa.autoassign.buyer@mockqa.test', propertyId: autoAssignProp.id, status: 'UNASSIGNED',
    },
  });
  index.autoAssign = {
    readyPartner: autoReady.id, pausedPartner: autoPaused.id,
    property: autoAssignProp.id, unassignedLeadId: autoAssignLead.id, unassignedLeadRefCode: autoAssignLead.refCode,
  };
  console.log('Auto-assign: 1 UNASSIGNED lead ready to be auto-assigned live (expected winner: Mock QA — Auto-Assign Ready), 1 paused decoy partner in the same locality.');

  // 11. Data acknowledgments ----------------------------------------------------
  await dataAckSvc.record(agent.id, { type: 'LEAD_DATA_HANDLING', version: '2026-10-v1' }, '127.0.0.1');
  await dataAckSvc.record(agent.id, { type: 'POST_OTP_RESTRICTED_USE', version: '2026-10-v1', leadId: autoAssignLead.id }, '127.0.0.1');
  // noAck deliberately has none at all.

  index.dataAcknowledgments = { accepted: agent.id, acceptedLeadId: autoAssignLead.id, none: noAck.id };
  console.log('Data acknowledgments: 1 partner with both types accepted, 1 partner with none at all.');

  console.log('\n=== DONE — writing index to scripts/.mockStatesIndex.json for MOCK_DATA.md ===\n');
  require('fs').writeFileSync(
    require('path').join(__dirname, '.mockStatesIndex.json'),
    JSON.stringify(index, null, 2),
  );
  console.log(JSON.stringify(index, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); process.exit(0); });
