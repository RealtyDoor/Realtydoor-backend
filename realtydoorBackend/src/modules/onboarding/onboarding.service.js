const { randomUUID } = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const { notifyAdmins } = require('../../lib/notifications');
const { deleteFile, copyFile } = require('../../lib/fileUpload');
const { withKeyLock, withKeyLockWait } = require('../../lib/keyLock');
const { buildListing } = require('../../lib/onboardingToListing');
const { sendOnboardingFormReady, sendOnboardingReceived, sendOnboardingUpdate } = require('../../lib/email');
const { sendOnboardingWhatsApp, liveSet } = require('../../lib/wati');
const f = require('../../lib/onboardingForm');
const { encryptToken, decryptToken } = require('../../lib/linkVault');

const asList = (v) => (Array.isArray(v) ? v : []);

// ─── Sender side (private link, no login) ─────────────────────────────────────

/** Finds the request for a link. A bad, revoked or expired link gets one answer, so a guess learns nothing. */
async function loadByToken(token, { needEditable = false } = {}) {
  if (!f.looksLikeToken(token)) throw new ApiError(404, 'This link is not valid.', { code: 'LINK_INVALID' });
  const row = await prisma.onboardingRequest.findFirst({ where: { tokenHash: f.hashToken(token) } });
  const { state, editable } = f.linkState(row);
  if (state === 'missing' || state === 'revoked') throw new ApiError(404, 'This link is not valid.', { code: 'LINK_INVALID' });
  if (state === 'expired') throw new ApiError(410, 'This link has expired. Ask us for a new one.', { code: 'LINK_EXPIRED' });
  if (needEditable && !editable) throw new ApiError(409, 'We already have your details and our team is reviewing them. Please contact us to change anything.', { code: 'LINK_LOCKED' });
  return { row, editable };
}

function senderView(row, editable) {
  return {
    propertyType: row.propertyType,
    title: row.title || null,
    contactName: row.contactName,
    contactRole: row.contactRole || null,
    status: row.status,
    editable,
    submittedAt: row.submittedAt,
    expiresAt: row.expiresAt,
    data: row.data || {},
    documents: asList(row.documents).map(f.publicDocument),
  };
}

async function senderGet(token) {
  const { row, editable } = await loadByToken(token);
  return senderView(row, editable);
}

async function senderSave(token, body) {
  const { row } = await loadByToken(token, { needEditable: true });
  const data = f.sanitizeAnswers(body?.data);
  const updated = await prisma.onboardingRequest.update({ where: { id: row.id }, data: { data, lastSavedAt: new Date() } });
  return { savedAt: updated.lastSavedAt };
}

async function senderSubmit(token, body) {
  const { row } = await loadByToken(token, { needEditable: true });
  // Submit carries the latest answers too, so the last keystrokes are never lost.
  const data = body?.data !== undefined ? f.sanitizeAnswers(body.data) : (row.data || {});
  if (!Object.keys(data).length && !asList(row.documents).length) throw new ApiError(400, 'Please fill in some details or add a document before sending.', { code: 'EMPTY_FORM' });
  const now = new Date();
  await prisma.onboardingRequest.update({ where: { id: row.id }, data: { data, status: 'RECEIVED', submittedAt: now, lastSavedAt: now } });
  await notifyAdmins({
    title: 'Build-out form received',
    message: `${row.contactName} sent their ${row.title || 'property'} details.`,
    type: 'ONBOARDING_RECEIVED',
    linkUrl: `/admin/onboarding/${row.id}`,
  });
  tellSender('received', row, null);
  return { submittedAt: now };
}

/** Adds an uploaded file (already stored by the upload middleware) to the request's document list. */
// Audit Nov 2026 (P10). The document list is one JSON value, so two uploads at once each wrote "the list I read plus my
// file" and one file was lost. Changes to the list now take turns, and each reads the list fresh inside its turn.
const docsBusy = () => new ApiError(409, 'Another file is still being saved. Please try again.', { code: 'DOCUMENTS_BUSY' });
async function freshDocuments(id) {
  const fresh = await prisma.onboardingRequest.findUnique({ where: { id }, select: { documents: true } });
  return asList(fresh?.documents);
}

async function attachDocument(row, key, file, by) {
  const rollback = () => (file.s3Key ? deleteFile(file.s3Key).catch(() => {}) : undefined);
  try {
    return await withKeyLockWait(`onboarding-docs:${row.id}`, () => attachDocumentLocked(row, key, file, by, rollback), { onBusy: docsBusy });
  } catch (err) {
    if (err?.data?.code === 'DOCUMENTS_BUSY') await rollback();
    throw err;
  }
}

async function attachDocumentLocked(row, key, file, by, rollback) {
  const docKey = f.cleanDocKey(key);
  const docs = await freshDocuments(row.id);
  if (docs.length >= f.MAX_DOCUMENTS || docs.filter((d) => d.key === docKey).length >= f.MAX_PER_DOC_KEY) {
    await rollback();
    throw new ApiError(400, 'That is the most files we can take for this item.', { code: 'TOO_MANY_FILES' });
  }
  const doc = {
    id: randomUUID(), key: docKey, name: String(file.originalname || 'file').slice(0, 150), size: file.size || 0,
    url: file.path, s3Key: file.s3Key, uploadedAt: new Date().toISOString(), by,
  };
  await prisma.onboardingRequest.update({ where: { id: row.id }, data: { documents: [...docs, doc], lastSavedAt: new Date() } });
  return f.publicDocument(doc);
}

async function removeDocument(row, docId) {
  const doc = await withKeyLockWait(`onboarding-docs:${row.id}`, async () => {
    const docs = await freshDocuments(row.id);
    const found = docs.find((d) => d.id === docId);
    if (!found) throw new ApiError(404, 'File not found.');
    await prisma.onboardingRequest.update({ where: { id: row.id }, data: { documents: docs.filter((d) => d.id !== docId), lastSavedAt: new Date() } });
    return found;
  }, { onBusy: docsBusy });
  if (doc.s3Key) deleteFile(doc.s3Key).catch((err) => logger.warn('[onboarding] could not delete file', { error: err.message }));
}

// ─── Admin side ───────────────────────────────────────────────────────────────

const adminView = (row) => ({
  ...row,
  tokenHash: undefined,
  tokenEnc: undefined, // the saved link never leaves the server; only the copy and resend endpoints use it
  hasSavedLink: !!row.tokenEnc,
  documents: asList(row.documents).map(({ s3Key, ...d }) => d),
  linkState: f.linkState(row).state,
});

const listItem = (row) => ({
  id: row.id, title: row.title, propertyType: row.propertyType, status: row.status,
  contactName: row.contactName, contactPhone: row.contactPhone, contactRole: row.contactRole,
  hasEmail: !!row.contactEmail, hasPhone: !!row.contactPhone, hasSavedLink: !!row.tokenEnc,
  documentCount: asList(row.documents).length, answerCount: Object.keys(row.data || {}).length,
  submittedAt: row.submittedAt, expiresAt: row.expiresAt, linkState: f.linkState(row).state, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

async function adminList(query, skip, limit) {
  const where = {};
  if (query.status && f.STATUSES.includes(query.status)) where.status = query.status;
  if (query.propertyType && f.ONBOARDING_TYPES.includes(query.propertyType)) where.propertyType = query.propertyType;
  const [rows, total] = await Promise.all([
    prisma.onboardingRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.onboardingRequest.count({ where }),
  ]);
  return { data: rows.map(listItem), total };
}

async function adminGet(id) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  return adminView(row);
}

const audit = (adminId, action, id, metadata, ipAddress) =>
  createAuditLog({ adminId, action, targetType: 'OnboardingRequest', targetId: String(id), metadata, ipAddress })
    .catch((err) => logger.warn('[onboarding] audit failed', { action, error: err.message }));


// ─── Messages to the sender (builder or owner) ─────────────────────────────────────────────────────────────────────────────────────────
// Sent when the link is created or re-issued ("ready") and when they press Send ("received"), by email and by WhatsApp, only to the contact
// details the team typed. Fire and forget: a failed email must never block creating a link or sending a form. WhatsApp is silent until its
// template is approved and listed in WATI_LIVE_TEMPLATES. Returns what will go out, so the admin screen can say so.
const formUrlFor = (token) => `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/listing-form/${token}`;

function tellSender(kind, row, token) {
  const info = { name: row.contactName, title: row.title };
  const whatsappTemplate = kind === 'ready' ? 'onboarding_form_ready' : 'onboarding_form_received';
  const live = liveSet();
  const whatsappLive = !!row.contactPhone && (live.has(whatsappTemplate) || (kind === 'ready' && live.has('onboarding_form_ready_v2')));
  if (row.contactEmail) {
    const mail = kind === 'ready'
      ? sendOnboardingFormReady(row.contactEmail, { ...info, formUrl: formUrlFor(token), expiresAt: row.expiresAt })
      : sendOnboardingReceived(row.contactEmail, info);
    Promise.resolve(mail).catch((e) => logger.warn('[onboarding] email to the sender failed', { requestId: row.id, kind, error: e.message }));
  }
  if (whatsappLive) {
    Promise.resolve(sendOnboardingWhatsApp(row.contactPhone, whatsappTemplate, { name: row.contactName, project: row.title, formLink: kind === 'ready' ? formUrlFor(token) : '' }))
      .catch((e) => logger.warn('[onboarding] WhatsApp to the sender failed', { requestId: row.id, kind, error: e.message }));
  }
  return { email: !!row.contactEmail, whatsapp: whatsappLive, whatsappWaitingForTemplate: !!row.contactPhone && !whatsappLive };
}

// The status the team moves a request to, and the email the sender gets for it. RECEIVED is not here: that email goes when the sender presses Send.
// SENT is the "link ready" email (create / New link). WhatsApp (21 Nov 2026): one template, onboarding_status_update, silent until it is live.
const STATUS_EMAIL = { IN_DISCUSSION: 'in_discussion', READY: 'ready_to_list', CONVERTED: 'listing_created', CLOSED: 'closed' };

function tellSenderStatus(newStatus, row) {
  const kind = STATUS_EMAIL[newStatus];
  if (kind && row.contactPhone) {
    Promise.resolve(sendOnboardingWhatsApp(row.contactPhone, 'onboarding_status_update', { name: row.contactName, project: row.title, statusKind: kind }))
      .catch((e) => logger.warn('[onboarding] status WhatsApp to the sender failed', { requestId: row.id, kind, error: e.message }));
  }
  if (!kind || !row.contactEmail) return false;
  Promise.resolve(sendOnboardingUpdate(row.contactEmail, kind, { name: row.contactName, title: row.title }))
    .catch((e) => logger.warn('[onboarding] status email to the sender failed', { requestId: row.id, kind, error: e.message }));
  return true;
}

async function adminCreate(adminId, body, ip) {
  const token = f.newToken();
  const row = await prisma.onboardingRequest.create({
    data: {
      tokenHash: f.hashToken(token),
      tokenEnc: encryptToken(token),
      propertyType: body.propertyType,
      title: body.title || null,
      contactName: body.contactName,
      contactPhone: body.contactPhone || null,
      contactEmail: body.contactEmail || null,
      contactRole: body.contactRole || null,
      status: 'SENT',
      data: {}, documents: [], adminNotes: [],
      expiresAt: f.expiryFromDays(body.expiresInDays),
      createdByAdminId: adminId,
    },
  });
  await audit(adminId, 'ONBOARDING_CREATED', row.id, { propertyType: row.propertyType }, ip);
  // The secret is shown to the admin once, here. Only its hash is kept.
  const notified = tellSender('ready', row, token);
  return { ...adminView(row), token, notified };
}

async function adminUpdate(adminId, id, body, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  // Once it has become a listing the request is a closed record: the listing is the live thing from then on.
  if (row.status === 'CONVERTED' && body.status !== undefined) throw new ApiError(409, 'This one has already become a listing, so its status can no longer change.', { code: 'ALREADY_CONVERTED', propertyId: row.convertedToId });
  const data = {};
  for (const k of ['title', 'contactName', 'contactPhone', 'contactEmail', 'contactRole']) if (body[k] !== undefined) data[k] = body[k] || null;
  if (data.contactName === null) delete data.contactName;
  if (body.data !== undefined) data.data = f.sanitizeAnswers(body.data);
  if (body.status !== undefined) {
    if (body.status === 'SENT') throw new ApiError(400, 'Use "Re-open link" to ask for more details.');
    if (body.status === 'CONVERTED') throw new ApiError(400, 'Use "Create listing" to convert it.');
    data.status = body.status;
  }
  // Audit Nov 2026 (P20). The link to the listing is written by "Create listing" only; it can be cleared here, never typed in.
  if (body.convertedToId) throw new ApiError(400, 'The listing link is set by "Create listing". It cannot be entered by hand.', { code: 'CONVERTED_LINK_READ_ONLY' });
  if (body.convertedToType !== undefined) data.convertedToType = body.convertedToType || null;
  if (body.convertedToId !== undefined) data.convertedToId = body.convertedToId || null;
  if (body.propertyType !== undefined) data.propertyType = body.propertyType;
  data.lastSavedAt = new Date();
  const updated = await prisma.onboardingRequest.update({ where: { id }, data });
  await audit(adminId, 'ONBOARDING_UPDATED', id, { fields: Object.keys(data).filter((k) => k !== 'lastSavedAt'), status: updated.status }, ip);
  // A real status change (not the same status saved again) emails the sender what the team did.
  const emailed = data.status && data.status !== row.status ? tellSenderStatus(data.status, updated) : false;
  return { ...adminView(updated), ...(data.status && data.status !== row.status ? { statusEmailSent: emailed } : {}) };
}

async function adminAddNote(adminId, id, text, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  const notes = [...asList(row.adminNotes), { at: new Date().toISOString(), adminId, text }].slice(-200);
  const updated = await prisma.onboardingRequest.update({ where: { id }, data: { adminNotes: notes } });
  await audit(adminId, 'ONBOARDING_NOTE_ADDED', id, null, ip);
  return adminView(updated);
}

/** A fresh link (the old one stops working), the sender can edit again, and the expiry restarts. */
async function adminReopen(adminId, id, expiresInDays, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  if (row.status === 'CONVERTED' || row.convertedToId) throw new ApiError(409, 'This one has already become a listing.');
  const token = f.newToken();
  const updated = await prisma.onboardingRequest.update({
    where: { id },
    data: { tokenHash: f.hashToken(token), tokenEnc: encryptToken(token), revokedAt: null, status: 'SENT', expiresAt: f.expiryFromDays(expiresInDays) },
  });
  await audit(adminId, 'ONBOARDING_LINK_REISSUED', id, null, ip);
  const notified = tellSender('ready', updated, token);
  return { ...adminView(updated), token, notified };
}

async function adminRevoke(adminId, id, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  const updated = await prisma.onboardingRequest.update({ where: { id }, data: { revokedAt: new Date(), tokenEnc: null } });
  await audit(adminId, 'ONBOARDING_LINK_REVOKED', id, null, ip);
  return adminView(updated);
}

// ─── Copy and resend a link that was already made ─────────────────────────────────────────────────────────────────────────────────────
// Possible only for links made after links were saved (hasSavedLink). An older one cannot be read back: "New link" makes one that can.
const NO_SAVED_LINK = 'This link was made before links could be saved, so it cannot be shown again. Press "New link" to make one you can copy and resend any time. The old link will stop working.';
const resendAt = new Map(); // request id -> time of the last resend (one process; a short pause so a double click cannot send twice)
const RESEND_PAUSE_MS = 30 * 1000;

async function savedLinkFor(id) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  if (row.status === 'CONVERTED' || row.convertedToId) throw new ApiError(409, 'This one has already become a listing, so its link is closed.', { code: 'LINK_CLOSED' });
  const { state } = f.linkState(row);
  if (state === 'revoked') throw new ApiError(409, 'This link was switched off. Press "New link" to make a new one.', { code: 'LINK_CLOSED' });
  if (state === 'expired') throw new ApiError(409, 'This link has expired. Press "New link" to make a new one.', { code: 'LINK_CLOSED' });
  const token = row.tokenEnc ? decryptToken(row.tokenEnc) : null;
  if (!token) throw new ApiError(409, NO_SAVED_LINK, { code: 'NO_SAVED_LINK' });
  return { row, token };
}

/** The private link, for the admin's "Copy link". Audited every time, because the link is a key to that builder's form. */
async function adminCopyLink(adminId, id, ip) {
  const { token } = await savedLinkFor(id);
  await audit(adminId, 'ONBOARDING_LINK_COPIED', id, null, ip);
  return { token };
}

/** Sends the SAME link again, by email and by WhatsApp (when live), to the contact details on the request. Nothing changes for a link the sender already has. */
async function adminResend(adminId, id, ip) {
  const { row, token } = await savedLinkFor(id);
  const last = resendAt.get(id) || 0;
  if (Date.now() - last < RESEND_PAUSE_MS) throw new ApiError(429, 'It was just sent. Please wait a moment before sending again.', { code: 'RESEND_TOO_SOON' });
  const notified = tellSender('ready', row, token);
  if (notified.email || notified.whatsapp) resendAt.set(id, Date.now());
  await audit(adminId, 'ONBOARDING_LINK_RESENT', id, { email: notified.email, whatsapp: notified.whatsapp }, ip);
  return { notified };
}

// ─── Convert to a listing ─────────────────────────────────────────────────────

const CONVERTIBLE = ['READY'];
const projectSlug = (title) => `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now()}`; // same shape as project.service.js

/** What the request would become as a listing, and what is still missing. Nothing is written. */
async function listingPreview(id) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  const { payload, problems, notCopied, counts, project } = buildListing(row);
  // What the optional builder project would carry (never the file objects or bucket keys).
  const projectView = project.available ? { available: true, canCreate: project.canCreate && problems.length === 0, carries: project.carries, units: 'none: units are added later by the builder or an admin' } : { available: false, reason: project.reason };
  return { status: row.status, canConvert: CONVERTIBLE.includes(row.status) && problems.length === 0, payload, problems, notCopied, counts, project: projectView, convertedToId: row.convertedToId || null };
}

/**
 * Creates the listing from a READY request, owned by the chosen partner and sent to the normal review queue (PENDING_APPROVAL).
 * Files are copied out of the private onboarding folder first (photos to the listing's pictures, papers to its private documents);
 * if the listing cannot be created the copies are removed again, and the request is left untouched.
 * With createProject (new projects only) the builder's Project record is made first and the listing is created already linked to it;
 * if the listing then fails, that project is deleted too. The project starts with no units.
 */
async function convertToListing(adminId, id, opts, ip) {
  // Audit Nov 2026 (P10). One conversion at a time per request: a double click used to pass the "already converted"
  // check twice and make two listings. Copying files can take a while, hence the longer stale time.
  const locked = await withKeyLock(`onboarding-convert:${id}`, () => convertToListingLocked(adminId, id, opts, ip), { staleSeconds: 180 });
  if (locked.busy) throw new ApiError(409, 'This request is already being turned into a listing. Give it a moment.', { code: 'CONVERT_IN_PROGRESS' });
  return locked.value;
}

async function convertToListingLocked(adminId, id, { partnerId, createProject = false }, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  // Checked on the link to the listing as well as the status, so a request that was somehow moved back can never make a second listing.
  if (row.status === 'CONVERTED' || row.convertedToId) throw new ApiError(409, 'This one has already become a listing.', { code: 'ALREADY_CONVERTED', propertyId: row.convertedToId });
  if (!CONVERTIBLE.includes(row.status)) throw new ApiError(409, 'Move it to "Ready to list" first, once the details are agreed.', { code: 'NOT_READY' });
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, role: 'PARTNER', OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
    select: { id: true, name: true, isSuspended: true },
  });
  if (!partner) throw new ApiError(400, 'Choose the partner account that will own this listing.', { code: 'PARTNER_REQUIRED' });
  // KYC is not asked for here: the listing starts as pending, and approval refuses it until the partner is verified.
  if (partner.isSuspended) throw new ApiError(400, 'This partner is suspended. Choose another partner, or lift the suspension first.', { code: 'PARTNER_SUSPENDED' });

  if (createProject && row.propertyType !== 'NEW_PROJECT') throw new ApiError(400, 'Only a new project can also become a builder project record.', { code: 'PROJECT_ONLY_FOR_NEW_PROJECT' });
  const { payload, problems, files, project: projectPlan } = buildListing(row);
  if (problems.length) throw new ApiError(400, 'Some details are still missing for a listing.', { code: 'CONVERT_INCOMPLETE', problems });
  if (createProject && !projectPlan.canCreate) throw new ApiError(400, 'The project record needs the address, locality, city, state, pincode and a description first.', { code: 'PROJECT_INCOMPLETE' });

  const copied = [];
  const carry = async (doc, folder) => {
    const out = await copyFile(doc.s3Key, folder);
    copied.push(out.key);
    return out;
  };
  let property;
  let project = null;
  try {
    const images = [];
    for (const d of files.images) images.push((await carry(d, 'properties')).url);
    const documents = [];
    const urlOf = new Map(); // the private copy made for each file, so the project's approval links reuse it instead of copying twice
    for (const d of files.documents) {
      const out = await carry(d, 'properties/documents');
      urlOf.set(d.id, out.url);
      documents.push({ name: d.name, url: out.url, uploadedAt: new Date().toISOString() });
    }
    const floorPlanUrl = files.floorPlan ? (await carry(files.floorPlan, 'properties')).url : undefined;
    if (createProject) {
      const links = Object.fromEntries(Object.entries(projectPlan.docs).map(([field, d]) => [field, urlOf.get(d.id)]).filter(([, url]) => url));
      project = await prisma.project.create({
        data: { ...projectPlan.fields, ...links, slug: projectSlug(projectPlan.fields.title), builderId: partner.id, publishStatus: 'PENDING_APPROVAL' },
      });
    }
    const { createProperty } = require('../properties/properties.service');
    property = await createProperty({ ...payload, images, documents, ...(floorPlanUrl && { floorPlanUrl }), ...(project && { projectId: project.id }) }, partner.id);
  } catch (err) {
    if (project) await prisma.project.delete({ where: { id: project.id } }).catch((e) => logger.warn('[onboarding] could not remove the project after a failed convert', { error: e.message }));
    await Promise.all(copied.map((k) => deleteFile(k).catch(() => {})));
    throw err;
  }

  // The project's id is kept on the request as a system note, so it can still be found after the answer screen is gone.
  const notes = project
    ? [...asList(row.adminNotes), { at: new Date().toISOString(), adminId, text: `Builder project record created (id ${project.id}), with no units yet. Units are added later by the builder or an admin.` }].slice(-200)
    : undefined;
  await prisma.onboardingRequest.update({
    where: { id },
    data: { status: 'CONVERTED', convertedToType: 'PROPERTY', convertedToId: property.id, tokenEnc: null, lastSavedAt: new Date(), ...(notes && { adminNotes: notes }) },
  });
  await audit(adminId, 'ONBOARDING_CONVERTED', id, { propertyId: property.id, partnerId: partner.id, ...(project && { projectId: project.id }) }, ip);
  const statusEmailSent = tellSenderStatus('CONVERTED', row);
  return { statusEmailSent, propertyId: property.id, slug: property.slug, partnerName: partner.name, ...(project && { projectId: project.id }) };
}

module.exports = {
  listingPreview, convertToListing,
  loadByToken, senderGet, senderSave, senderSubmit, attachDocument, removeDocument,
  adminList, adminGet, adminCreate, adminUpdate, adminAddNote, adminReopen, adminRevoke, adminCopyLink, adminResend,
};
