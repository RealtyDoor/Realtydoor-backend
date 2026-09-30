'use strict';

// Backed by the partial unique index from scripts/createEscrowLeadUniqueIndex.js
// (name: escrow_active_lead_unique) — see escrow.service.js's createOrder for
// why this exists (the same TOCTOU pattern as isPhoneUniqueViolation in
// phoneUtils.js).
function isEscrowLeadUniqueViolation(err) {
  return err?.code === 'P2002' && err?.meta?.target === 'escrow_active_lead_unique';
}

module.exports = { isEscrowLeadUniqueViolation };
