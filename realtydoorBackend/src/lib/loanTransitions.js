// B60 — admin updateLoanStatus used to accept any status -> any status
// (e.g. DISBURSED back to DOCUMENTS_PENDING). The pipeline is linear; this is
// the single rule it is checked against.
const PIPELINE = [
  'DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED',
  'SENT_TO_BANK', 'AWAITING_SANCTION', 'SANCTIONED', 'DISBURSED',
];
const SANCTIONED_INDEX = PIPELINE.indexOf('SANCTIONED');

// Forward moves may skip stages (new applications already start at
// DOCUMENTS_VERIFIED, and admin may jump straight to SANCTIONED). Backward
// moves are allowed only before SANCTIONED (e.g. a document turns out to be
// bad after verification). REJECTED can be reached from any open stage and is
// final, as is DISBURSED.
function isLoanTransitionAllowed(from, to) {
  if (from === to) return false;
  if (from === 'REJECTED' || from === 'DISBURSED') return false;
  if (to === 'REJECTED') return true;
  const fromIdx = PIPELINE.indexOf(from);
  const toIdx = PIPELINE.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  if (toIdx > fromIdx) return true;
  return fromIdx < SANCTIONED_INDEX;
}

// T53 — "documents verified" means at least one attached document has been
// approved; a loan with nothing uploaded cannot pass that stage.
function hasVerifiedDocument(documents) {
  return Array.isArray(documents) && documents.some((d) => d && d.status === 'APPROVED');
}

module.exports = { hasVerifiedDocument, isLoanTransitionAllowed, LOAN_PIPELINE: PIPELINE };
