// B119 — the buyer's ticket screens need the charge breakdown, the receipt and
// the admin's resolution note. The raw columns were already on the row but under
// internal names (totalCharge / invoiceUrl) and with the resolution note mixed
// into adminNotes. This adds the buyer-facing names alongside, without removing
// anything the current frontend may already read.
function presentTicketForBuyer(ticket) {
  if (!ticket) return ticket;
  return {
    ...ticket,
    visitCharge: ticket.visitCharge ?? null,
    partsCharge: ticket.partsCharge ?? null,
    total: ticket.totalCharge ?? null,
    receiptUrl: ticket.invoiceUrl ?? null,
    resolutionNote: ticket.resolutionNote ?? null,
  };
}

module.exports = { presentTicketForBuyer };
