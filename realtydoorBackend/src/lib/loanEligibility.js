const prisma = require('./prisma');

// Backend gaps handoff, 2026-10-10 (#5) — the frontend's loan form blocks
// submission until the user's documents are verified, but nothing enforced
// that server-side, so a direct POST /user/loan call could bypass it
// entirely. This is the one place that decision is made, used by both
// GET /user/loan/eligibility and POST /user/loan (users.service.js).
//
// Resident users: PAN_CARD + AADHAR, plus one of SALARY_SLIP/FORM_16/
// BANK_STATEMENT as income proof.
// isNRI users: PAN_CARD + PASSPORT, plus one of OCI_PIO_CARD/POA_DRAFT/
// POA_NOTARIZED/NRE_NRO_PROOF, plus the same income-proof group.
const INCOME_PROOF_GROUP = ['SALARY_SLIP', 'FORM_16', 'BANK_STATEMENT'];
const NRI_SUPPORTING_GROUP = ['OCI_PIO_CARD', 'POA_DRAFT', 'POA_NOTARIZED', 'NRE_NRO_PROOF'];

const STATE_RANK = { verified: 0, under_review: 1, expired: 2, rejected: 3, missing: 4 };

function serializeDoc(doc) {
  return { ...doc, uploadedAt: doc.uploadedAt?.toISOString?.() ?? doc.uploadedAt };
}

function stateOf(doc) {
  if (!doc) return 'missing';
  if (doc.status === 'REJECTED') return 'rejected';
  // Mirrors ExclusiveMandate/PropertyChangeRequest's established pattern in
  // this codebase: EXPIRED is also derived live from expiresAt, never
  // trusted as a stored status alone — nothing flips status to EXPIRED on a
  // schedule, so a document past its date but still PENDING_REVIEW/APPROVED
  // in the DB must still count as expired here.
  if (doc.status === 'EXPIRED' || (doc.expiresAt && doc.expiresAt < new Date())) return 'expired';
  if (doc.status === 'APPROVED') return 'verified';
  return 'under_review';
}

// `db` defaults to the shared client, but POST /user/loan passes a
// transaction handle so the re-check immediately before the insert and the
// insert itself see the same consistent snapshot (users.service.js).
async function getLoanEligibility(userId, db = prisma) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isNRI: true } });

  const documents = await db.userDocument.findMany({
    where: { userId },
    orderBy: { uploadedAt: 'desc' },
  });

  // Most recently uploaded document per type — a fresh re-upload after a
  // rejection must take over, not stay masked behind the old rejected row.
  const latestByType = {};
  for (const doc of documents) {
    if (!latestByType[doc.documentType]) latestByType[doc.documentType] = doc;
  }

  function singleRow(type) {
    const doc = latestByType[type];
    return { type, state: stateOf(doc), document: doc ? serializeDoc(doc) : undefined };
  }

  function groupRow(groupLabel, types) {
    let best = { doc: latestByType[types[0]] };
    let bestState = stateOf(best.doc);
    for (const type of types.slice(1)) {
      const doc = latestByType[type];
      const state = stateOf(doc);
      if (STATE_RANK[state] < STATE_RANK[bestState]) { best = { doc }; bestState = state; }
    }
    return { type: groupLabel, acceptableTypes: types, state: bestState, document: best.doc ? serializeDoc(best.doc) : undefined };
  }

  const rows = user?.isNRI
    ? [
        singleRow('PAN_CARD'),
        singleRow('PASSPORT'),
        groupRow('NRI_SUPPORTING_DOC', NRI_SUPPORTING_GROUP),
        groupRow('INCOME_PROOF', INCOME_PROOF_GROUP),
      ]
    : [
        singleRow('PAN_CARD'),
        singleRow('AADHAR'),
        groupRow('INCOME_PROOF', INCOME_PROOF_GROUP),
      ];

  const blocking = rows.filter((r) => r.state !== 'verified');

  return {
    eligible: blocking.length === 0,
    rows,
    blocking: blocking.map(({ type, state }) => ({ type, state })),
    documents: documents.map(serializeDoc),
  };
}

// The actual document ids POST /user/loan attaches when eligible — the
// latest APPROVED, non-expired one per required row. Server-chosen, not
// trusted from the request body (see users.service.js::createLoanApplication).
function resolveVerifiedDocIds(eligibility) {
  return eligibility.rows
    .filter((r) => r.state === 'verified' && r.document)
    .map((r) => r.document.id);
}

// Backend gaps handoff, 2026-10-10 (#6) — documents[] on loan reads. The SET
// of which documents belong to a loan is frozen (documentSnapshot, or for a
// loan created before that field existed, submittedDocIds — no backfill),
// but status/verifiedAt/expiresAt/rejectionNote are re-joined against
// UserDocument live, so a later re-review is reflected without touching the
// loan record itself. Accepts a single loan or an array; returns the same shape back.
async function attachLoanDocuments(loanOrLoans, db = prisma) {
  const isArray = Array.isArray(loanOrLoans);
  const loans = isArray ? loanOrLoans : [loanOrLoans];

  const idsFor = (loan) => (loan.documentSnapshot?.length
    ? loan.documentSnapshot.map((d) => d.documentId)
    : (loan.submittedDocIds || []));

  const allIds = [...new Set(loans.flatMap(idsFor))];
  const byId = allIds.length
    ? new Map((await db.userDocument.findMany({ where: { id: { in: allIds } } })).map((d) => [d.id, d]))
    : new Map();

  const withDocs = loans.map((loan) => ({
    ...loan,
    documents: idsFor(loan)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((d) => ({
        id: d.id, documentType: d.documentType, fileName: d.fileName, fileUrl: d.fileUrl,
        status: d.status, uploadedAt: d.uploadedAt, verifiedAt: d.verifiedAt,
        expiresAt: d.expiresAt, rejectionNote: d.rejectionNote, verifiedByAdminId: d.verifiedByAdminId,
      })),
  }));

  return isArray ? withDocs : withDocs[0];
}

module.exports = { getLoanEligibility, resolveVerifiedDocIds, attachLoanDocuments, stateOf, serializeDoc };
