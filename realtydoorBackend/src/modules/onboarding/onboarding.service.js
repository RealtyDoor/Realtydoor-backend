const { randomUUID } = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const { notifyAdmins } = require('../../lib/notifications');
const { deleteFile, copyFile } = require('../../lib/fileUpload');
const { buildListing } = require('../../lib/onboardingToListing');
const f = require('../../lib/onboardingForm');

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
  return { submittedAt: now };
}

/** Adds an uploaded file (already stored by the upload middleware) to the request's document list. */
async function attachDocument(row, key, file, by) {
  const docKey = f.cleanDocKey(key);
  const docs = asList(row.documents);
  const rollback = () => (file.s3Key ? deleteFile(file.s3Key).catch(() => {}) : undefined);
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
  const docs = asList(row.documents);
  const doc = docs.find((d) => d.id === docId);
  if (!doc) throw new ApiError(404, 'File not found.');
  await prisma.onboardingRequest.update({ where: { id: row.id }, data: { documents: docs.filter((d) => d.id !== docId), lastSavedAt: new Date() } });
  if (doc.s3Key) deleteFile(doc.s3Key).catch((err) => logger.warn('[onboarding] could not delete file', { error: err.message }));
}

// ─── Admin side ───────────────────────────────────────────────────────────────

const adminView = (row) => ({
  ...row,
  tokenHash: undefined,
  documents: asList(row.documents).map(({ s3Key, ...d }) => d),
  linkState: f.linkState(row).state,
});

const listItem = (row) => ({
  id: row.id, title: row.title, propertyType: row.propertyType, status: row.status,
  contactName: row.contactName, contactPhone: row.contactPhone, contactRole: row.contactRole,
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

async function adminCreate(adminId, body, ip) {
  const token = f.newToken();
  const row = await prisma.onboardingRequest.create({
    data: {
      tokenHash: f.hashToken(token),
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
  return { ...adminView(row), token };
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
  if (body.convertedToType !== undefined) data.convertedToType = body.convertedToType || null;
  if (body.convertedToId !== undefined) data.convertedToId = body.convertedToId || null;
  if (body.propertyType !== undefined) data.propertyType = body.propertyType;
  data.lastSavedAt = new Date();
  const updated = await prisma.onboardingRequest.update({ where: { id }, data });
  await audit(adminId, 'ONBOARDING_UPDATED', id, { fields: Object.keys(data).filter((k) => k !== 'lastSavedAt'), status: updated.status }, ip);
  return adminView(updated);
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
    data: { tokenHash: f.hashToken(token), revokedAt: null, status: 'SENT', expiresAt: f.expiryFromDays(expiresInDays) },
  });
  await audit(adminId, 'ONBOARDING_LINK_REISSUED', id, null, ip);
  return { ...adminView(updated), token };
}

async function adminRevoke(adminId, id, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  const updated = await prisma.onboardingRequest.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit(adminId, 'ONBOARDING_LINK_REVOKED', id, null, ip);
  return adminView(updated);
}

// ─── Convert to a listing ─────────────────────────────────────────────────────

const CONVERTIBLE = ['READY'];

/** What the request would become as a listing, and what is still missing. Nothing is written. */
async function listingPreview(id) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  const { payload, problems, notCopied, counts } = buildListing(row);
  return { status: row.status, canConvert: CONVERTIBLE.includes(row.status) && problems.length === 0, payload, problems, notCopied, counts, convertedToId: row.convertedToId || null };
}

/**
 * Creates the listing from a READY request, owned by the chosen partner and sent to the normal review queue (PENDING_APPROVAL).
 * Files are copied out of the private onboarding folder first (photos to the listing's pictures, papers to its private documents);
 * if the listing cannot be created the copies are removed again, and the request is left untouched.
 */
async function convertToListing(adminId, id, { partnerId }, ip) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  // Checked on the link to the listing as well as the status, so a request that was somehow moved back can never make a second listing.
  if (row.status === 'CONVERTED' || row.convertedToId) throw new ApiError(409, 'This one has already become a listing.', { code: 'ALREADY_CONVERTED', propertyId: row.convertedToId });
  if (!CONVERTIBLE.includes(row.status)) throw new ApiError(409, 'Move it to "Ready to list" first, once the details are agreed.', { code: 'NOT_READY' });
  const partner = await prisma.user.findFirst({ where: { id: partnerId, role: 'PARTNER', deletedAt: { isSet: false } }, select: { id: true, name: true } });
  if (!partner) throw new ApiError(400, 'Choose the partner account that will own this listing.', { code: 'PARTNER_REQUIRED' });

  const { payload, problems, files } = buildListing(row);
  if (problems.length) throw new ApiError(400, 'Some details are still missing for a listing.', { code: 'CONVERT_INCOMPLETE', problems });

  const copied = [];
  const carry = async (doc, folder) => {
    const out = await copyFile(doc.s3Key, folder);
    copied.push(out.key);
    return out;
  };
  let property;
  try {
    const images = [];
    for (const d of files.images) images.push((await carry(d, 'properties')).url);
    const documents = [];
    for (const d of files.documents) {
      const out = await carry(d, 'properties/documents');
      documents.push({ name: d.name, url: out.url, uploadedAt: new Date().toISOString() });
    }
    const floorPlanUrl = files.floorPlan ? (await carry(files.floorPlan, 'properties')).url : undefined;
    const { createProperty } = require('../properties/properties.service');
    property = await createProperty({ ...payload, images, documents, ...(floorPlanUrl && { floorPlanUrl }) }, partner.id);
  } catch (err) {
    await Promise.all(copied.map((k) => deleteFile(k).catch(() => {})));
    throw err;
  }

  await prisma.onboardingRequest.update({
    where: { id },
    data: { status: 'CONVERTED', convertedToType: 'PROPERTY', convertedToId: property.id, lastSavedAt: new Date() },
  });
  await audit(adminId, 'ONBOARDING_CONVERTED', id, { propertyId: property.id, partnerId: partner.id }, ip);
  return { propertyId: property.id, slug: property.slug, partnerName: partner.name };
}

module.exports = {
  listingPreview, convertToListing,
  loadByToken, senderGet, senderSave, senderSubmit, attachDocument, removeDocument,
  adminList, adminGet, adminCreate, adminUpdate, adminAddNote, adminReopen, adminRevoke,
};
