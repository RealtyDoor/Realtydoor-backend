// B119 — the buyer's ticket screens need the charge breakdown, the receipt and
// the admin's resolution note. The raw columns were already on the row but under
// internal names (totalCharge / invoiceUrl) and with the resolution note mixed
// into adminNotes. This adds the buyer-facing names alongside, without removing
// anything the current frontend may already read.
// The visit charge is petty cash the company settles itself (T12): it is never part of what the buyer is shown or told, so
// visitCharge and totalCharge (which includes it) are left out, and `total` is what the buyer actually owes: the parts.
function presentTicketForBuyer(ticket) {
  if (!ticket) return ticket;
  const { visitCharge: _visit, totalCharge: _total, ...rest } = ticket; // eslint-disable-line no-unused-vars
  const parts = ticket.partsCharge ?? null;
  return {
    ...rest,
    partsCharge: parts,
    total: parts > 0 ? parts : null,
    receiptUrl: ticket.invoiceUrl ?? null,
    resolutionNote: ticket.resolutionNote ?? null,
  };
}

module.exports = { presentTicketForBuyer };
