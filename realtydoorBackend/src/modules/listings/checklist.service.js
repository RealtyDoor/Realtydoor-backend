const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const { isSelfListedByAgent } = require('./integrity.service');

// ─── 4.1 — persona-specific document checklist ──────────────────────────────
//
// Scope note: AGENT's checklist items are already fully modelled elsewhere —
// mandate letter (ExclusiveMandate.documentUrl), owner PAN
// (ExclusiveMandate.ownerPan) and owner confirmation (OwnerConfirmation,
// below) — so this file adds structured upload/verify only for the OWNER
// persona's genuinely unmodelled items. Loan NOC, also an owner item, already
// exists as Property.loanNocStatus/loanNocUrl (doc 4.5) and is folded into the
// same checklist response rather than duplicated here.
//
// BUILDER's items (RERA project number, approved plan, commencement
// certificate, land title, designated account) belong to a developer-led
// PROJECT, not a single unit listing — docs 4.10/4.11's Project entity, not
// yet modelled. Reported as "not yet available" rather than guessed at.

// Unconditionally required for every OWNER listing.
const OWNER_DOCUMENT_TYPES = ['SALE_DEED', 'ENCUMBRANCE_CERTIFICATE', 'KHATA', 'SOCIETY_NOC'];
// Conditionally required (see getChecklist's hasCoOwners/reraNumber checks),
// but uploadable at any time regardless — an owner may reasonably upload
// RERA_CERT before admin or anyone else has set reraNumber, for example.
const CONDITIONAL_OWNER_DOCUMENT_TYPES = ['CO_OWNER_CONSENT', 'RERA_CERT'];
// The full allowlist uploadChecklistDocument accepts.
const UPLOADABLE_OWNER_DOCUMENT_TYPES = [...OWNER_DOCUMENT_TYPES, ...CONDITIONAL_OWNER_DOCUMENT_TYPES];

const DOCUMENT_LABELS = {
  SALE_DEED: 'Sale deed',
  ENCUMBRANCE_CERTIFICATE: 'Encumbrance certificate',
  KHATA: 'Khata',
  SOCIETY_NOC: 'Society NOC',
  CO_OWNER_CONSENT: 'Co-owner consent',
  RERA_CERT: 'RERA certificate',
};

function checklistFor(subType) {
  if (subType === 'OWNER') {
    return {
      persona: 'OWNER',
      documents: OWNER_DOCUMENT_TYPES.map((type) => ({ type, label: DOCUMENT_LABELS[type] })),
      // Loan NOC is conditional, not a flat requirement — a non-mortgaged
      // property genuinely has nothing to upload here. See Property fields.
      conditionalItems: [
        'LOAN_NOC (only if the listing is mortgaged)',
        'CO_OWNER_CONSENT (only if hasCoOwners is true)',
        'RERA_CERT (only if reraNumber is set)',
      ],
    };
  }
  if (subType === 'AGENT') {
    return {
      persona: 'AGENT',
      documents: [],
      // Not PropertyDocument rows — each already has its own home, listed so
      // the checklist response can point at the right place instead of this
      // module inventing a duplicate.
      elsewhere: [
        { item: 'Mandate letter', source: 'ExclusiveMandate.documentUrl' },
        { item: 'Owner PAN', source: 'ExclusiveMandate.ownerPan' },
        { item: 'Owner confirmation', source: 'OwnerConfirmation (this module)' },
      ],
    };
  }
  if (subType === 'BUILDER') {
    return {
      persona: 'BUILDER',
      documents: [],
      available: false,
      reason: 'Builder compliance (RERA project number, approved plan, commencement certificate, '
        + 'land title, designated account) is modelled at the PROJECT level, which does not exist yet '
        + '(docs 4.10/4.11). Nothing to check per listing until then.',
    };
  }
  return {
    persona: subType || null,
    documents: [],
    available: false,
    reason: `No document checklist is defined for persona ${subType || '(unset)'}.`,
  };
}

// requirePartnerId, when passed, scopes this to the caller's own listing —
// used by the partner-facing route. The admin route omits it, matching every
// other admin property read, which has no ownership restriction.
async function getChecklist(propertyId, requirePartnerId = null) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { id: true, name: true, partnerSubType: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  if (requirePartnerId && property.partnerId !== requirePartnerId) {
    throw new ApiError(403, 'Not your listing');
  }

  // R21 — an AGENT whose in-force mandate names their own PAN as the owner's
  // is not representing a third party at all. There's no genuine mandate
  // letter/owner-PAN/owner-confirmation to collect from anyone else, so this
  // listing needs the OWNER persona's actual documents instead of pointing
  // at AGENT's "elsewhere" placeholders for items that can't exist here.
  const selfListed = property.partner.partnerSubType === 'AGENT' && await isSelfListedByAgent(propertyId);
  const persona = checklistFor(selfListed ? 'OWNER' : property.partner.partnerSubType);

  const [docs, mandate, confirmations] = await Promise.all([
    prisma.propertyDocument.findMany({ where: { propertyId } }),
    prisma.exclusiveMandate.findFirst({
      where: { propertyId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ownerConfirmation.findMany({
      where: { propertyId },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const byType = Object.fromEntries(docs.map((d) => [d.documentType, d]));
  // backend-work-still-open.md #12 — verify/reject (PATCH
  // .../checklist-documents/:docId/verify|reject) take the underlying
  // PropertyDocument row's id, which was never actually returned here.
  // null when nothing's been uploaded yet (MISSING) — there is no row id
  // to act on until there is.
  const items = (persona.documents || []).map(({ type, label }) => {
    const doc = byType[type];
    return {
      id: doc?.id ?? null, type, label,
      status: doc ? doc.status : 'MISSING',
      fileUrl: doc?.fileUrl ?? null,
      uploadedAt: doc?.uploadedAt ?? null,
      rejectionNote: doc?.rejectionNote ?? null,
    };
  });

  // Loan NOC folded in from Property directly, conditional on isMortgaged.
  // null (not recorded) and false (confirmed not mortgaged) are both "nothing
  // required here" — the distinction matters to the mortgage field itself,
  // not to this checklist. No PropertyDocument row backs this one at all —
  // id stays null; it's verified/rejected through the property's own
  // loanNocStatus field, not the checklist-documents endpoint.
  const loanNocItem = property.isMortgaged
    ? {
        id: null,
        type: 'LOAN_NOC',
        label: 'Loan NOC',
        status: property.loanNocStatus || 'MISSING',
        fileUrl: property.loanNocUrl,
        uploadedAt: null,
        rejectionNote: null,
      }
    : null;

  // R19 — CO_OWNER_CONSENT and RERA_CERT are real PropertyDocument uploads
  // (unlike loan NOC above), but still conditional: most listings have one
  // owner and no RERA registration claimed, so requiring either
  // unconditionally would ask most owners for a document that doesn't apply
  // to them. Pulled from the same byType map as the base items, exactly like
  // SALE_DEED etc. — only whether they're INCLUDED is conditional.
  const conditionalDocTypes = [];
  if (property.hasCoOwners) conditionalDocTypes.push({ type: 'CO_OWNER_CONSENT', label: 'Co-owner consent' });
  if (property.reraNumber) conditionalDocTypes.push({ type: 'RERA_CERT', label: 'RERA certificate' });
  const resolvedConditionalDocs = conditionalDocTypes.map(({ type, label }) => {
    const doc = byType[type];
    return {
      id: doc?.id ?? null, type, label,
      status: doc ? doc.status : 'MISSING',
      fileUrl: doc?.fileUrl ?? null,
      uploadedAt: doc?.uploadedAt ?? null,
      rejectionNote: doc?.rejectionNote ?? null,
    };
  });

  const allItems = [...items, ...(loanNocItem ? [loanNocItem] : []), ...resolvedConditionalDocs];
  const missing = allItems.filter((i) => i.status === 'MISSING' || i.status === 'REJECTED');

  // Newest non-SUPERSEDED confirmation, with status derived the same way
  // ExclusiveMandate derives EXPIRED — a stored PENDING row past its deadline
  // reads as TIMED_OUT without a scheduled job ever having to touch it.
  const latestConfirmation = confirmations.find((c) => c.status !== 'SUPERSEDED') || null;
  const confirmationStatus = latestConfirmation
    ? (latestConfirmation.status === 'PENDING' && latestConfirmation.expiresAt < new Date()
        ? 'TIMED_OUT'
        : latestConfirmation.status)
    : null;

  return {
    propertyId: property.id,
    partnerSubType: property.partner.partnerSubType,
    // R21 — true when the checklist above was routed to OWNER documents
    // despite the partner being registered as AGENT.
    selfListedByAgent: selfListed,
    persona: persona.persona,
    available: persona.available !== false,
    reason: persona.reason || null,
    items: allItems,
    missingCount: missing.length,
    ready: persona.available === false ? null : missing.length === 0,
    elsewhere: persona.elsewhere || [],
    conditionalItems: persona.conditionalItems || [],
    ownerConfirmation: latestConfirmation
      ? {
          id: latestConfirmation.id,
          status: confirmationStatus,
          ownerName: latestConfirmation.ownerName,
          ownerPhone: latestConfirmation.ownerPhone,
          requestedVia: latestConfirmation.requestedVia,
          requestedAt: latestConfirmation.requestedAt,
          expiresAt: latestConfirmation.expiresAt,
          respondedAt: latestConfirmation.respondedAt,
          responseNote: latestConfirmation.responseNote,
        }
      : null,
    activeMandateId: mandate?.id ?? null,
  };
}

// ─── Document upload / verify (OWNER persona) ────────────────────────────────

async function uploadChecklistDocument(propertyId, partnerId, { documentType, file }) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { partnerSubType: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');
  // R21 — a self-listing agent is routed to the OWNER checklist above, so
  // they must be allowed to upload against it too.
  const isOwnerPersona = property.partner.partnerSubType === 'OWNER'
    || (property.partner.partnerSubType === 'AGENT' && await isSelfListedByAgent(propertyId));
  if (!isOwnerPersona) {
    throw new ApiError(400,
      `This checklist document type is for the OWNER persona. This listing's partner is ${property.partner.partnerSubType || 'unset'}.`);
  }
  if (!UPLOADABLE_OWNER_DOCUMENT_TYPES.includes(documentType)) {
    throw new ApiError(400, `documentType must be one of ${UPLOADABLE_OWNER_DOCUMENT_TYPES.join(', ')}`);
  }

  // Upsert on the (propertyId, documentType) unique index: a re-upload
  // replaces the previous attempt and resets it to PENDING_REVIEW, rather
  // than leaving a rejected row sitting next to a new one for the checklist
  // to pick between.
  return prisma.propertyDocument.upsert({
    where: { propertyId_documentType: { propertyId, documentType } },
    create: {
      propertyId, documentType, uploadedByPartnerId: partnerId,
      fileUrl: file.path, fileName: file.originalname,
    },
    update: {
      fileUrl: file.path, fileName: file.originalname,
      status: 'PENDING_REVIEW', verifiedByAdminId: null, verifiedAt: null, rejectionNote: null,
      uploadedAt: new Date(),
    },
  });
}

async function verifyChecklistDocument(docId, adminId, ip) {
  const doc = await prisma.propertyDocument.findUnique({ where: { id: docId } });
  if (!doc) throw new ApiError(404, 'Document not found');

  const updated = await prisma.propertyDocument.update({
    where: { id: docId },
    data: { status: 'APPROVED', verifiedByAdminId: adminId, verifiedAt: new Date(), rejectionNote: null },
  });

  await createAuditLog({
    adminId, action: 'LISTING_DOCUMENT_VERIFIED', targetType: 'Property', targetId: doc.propertyId,
    after: { documentId: docId, documentType: doc.documentType },
    ipAddress: ip,
  });

  return updated;
}

async function rejectChecklistDocument(docId, note, adminId, ip) {
  const doc = await prisma.propertyDocument.findUnique({
    where: { id: docId },
    include: { property: { select: { title: true, partnerId: true } } },
  });
  if (!doc) throw new ApiError(404, 'Document not found');

  const updated = await prisma.propertyDocument.update({
    where: { id: docId },
    data: { status: 'REJECTED', verifiedByAdminId: adminId, verifiedAt: new Date(), rejectionNote: note },
  });

  await createNotification({
    userId: doc.property.partnerId,
    title: 'Listing document needs resubmission',
    message: `${DOCUMENT_LABELS[doc.documentType] || doc.documentType} on "${doc.property.title}" was rejected: ${note}`,
    type: 'LISTING_DOCUMENT_REJECTED',
    linkUrl: `/partner/listings/${doc.propertyId}`,
  });

  await createAuditLog({
    adminId, action: 'LISTING_DOCUMENT_REJECTED', targetType: 'Property', targetId: doc.propertyId,
    after: { documentId: docId, documentType: doc.documentType, note },
    ipAddress: ip,
  });

  return updated;
}

// ─── 4.2 — owner confirmation (admin-recorded, not WhatsApp-automated) ──────
//
// WATI template/conversation work for this is explicitly out of scope this
// phase (2026-10-04). An admin confirms with the owner by whatever channel is
// actually used and records the result; requestedVia is free text describing
// that channel, not something this backend drives.

const CONFIRMATION_WINDOW_MS = 48 * 60 * 60 * 1000;

async function requestOwnerConfirmation(propertyId, mandateId, { requestedVia }, adminId) {
  const mandate = await prisma.exclusiveMandate.findUnique({ where: { id: mandateId } });
  if (!mandate || mandate.propertyId !== propertyId) throw new ApiError(404, 'Mandate not found for this listing');

  // 4.2 is specifically about agent-submitted listings: an OWNER or BUILDER
  // partner is not claiming to act on someone else's behalf, so there is no
  // third-party authorization to confirm.
  const partner = await prisma.user.findUnique({ where: { id: mandate.partnerId }, select: { partnerSubType: true } });
  if (partner?.partnerSubType !== 'AGENT') {
    throw new ApiError(400,
      `Owner confirmation applies to agent-submitted listings. This mandate's partner is ${partner?.partnerSubType || 'unset'}.`);
  }

  // A newer request supersedes whatever is still PENDING, mirroring the
  // change-request supersede pattern — the queue only ever shows one live
  // confirmation per mandate.
  await prisma.ownerConfirmation.updateMany({
    where: { mandateId, status: 'PENDING' },
    data: { status: 'SUPERSEDED' },
  });

  const now = new Date();
  return prisma.ownerConfirmation.create({
    data: {
      propertyId, mandateId, partnerId: mandate.partnerId,
      ownerName: mandate.ownerName, ownerPhone: mandate.ownerPhone,
      requestedVia: requestedVia || null,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_WINDOW_MS),
    },
  });
}

async function recordOwnerConfirmationResponse(id, { status, note }, adminId, ip) {
  if (!['CONFIRMED', 'DENIED'].includes(status)) {
    throw new ApiError(400, 'status must be CONFIRMED or DENIED');
  }
  const confirmation = await prisma.ownerConfirmation.findUnique({
    where: { id },
    include: { property: { select: { title: true } } },
  });
  if (!confirmation) throw new ApiError(404, 'Owner confirmation not found');
  if (confirmation.status !== 'PENDING') {
    throw new ApiError(400, `This confirmation is already ${confirmation.status} and cannot be recorded again`);
  }

  const updated = await prisma.ownerConfirmation.update({
    where: { id },
    data: { status, responseNote: note, respondedAt: new Date(), respondedByAdminId: adminId },
  });

  // A denial is a real integrity problem, not a bookkeeping update — the
  // agent claimed authorization that the named owner did not give.
  if (status === 'DENIED') {
    await prisma.listingConflict.create({
      data: {
        propertyId: confirmation.propertyId,
        type: 'OWNER_DENIED_MANDATE',
        detail: `Owner "${confirmation.ownerName}" (${confirmation.ownerPhone}) denied authorizing this listing. ${note}`,
      },
    });
  }

  await createAuditLog({
    adminId, action: `OWNER_CONFIRMATION_${status}`, targetType: 'Property', targetId: confirmation.propertyId,
    before: { confirmationId: id, status: 'PENDING' },
    after: { status, note },
    ipAddress: ip,
  });

  return updated;
}

module.exports = {
  OWNER_DOCUMENT_TYPES, UPLOADABLE_OWNER_DOCUMENT_TYPES, CONFIRMATION_WINDOW_MS,
  getChecklist,
  uploadChecklistDocument, verifyChecklistDocument, rejectChecklistDocument,
  requestOwnerConfirmation, recordOwnerConfirmationResponse,
};
