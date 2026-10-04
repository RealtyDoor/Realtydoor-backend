const PDFDocument = require('pdfkit');

// R26 — a simple payment receipt for the owner's success fee: confirms the
// amount and that it was paid, no GST breakup (no GSTIN/HSN/CGST-SGST split
// — deliberately out of scope until the business is ready to issue a real
// tax invoice; upgrading this later doesn't require touching the Lead
// fields that reference it, only this file).
function formatRupees(amount) {
  if (amount == null) return 'N/A';
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

function buildCommissionReceiptPdf({ refCode, propertyTitle, payerName, feePct, dealPrice, feeAmount, invoicedAt, collectedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#111').text('RealtyDoor', { align: 'left' });
    doc.fontSize(11).fillColor('#666').text('Success Fee Receipt');
    doc.moveDown(0.5).fontSize(9).fillColor('#999')
      .text(`Receipt for lead ${refCode || ''}`.trim());

    doc.moveDown(1).fontSize(11).fillColor('#333');
    doc.text(`Billed to: ${payerName || 'N/A'}`);
    doc.text(`Property: ${propertyTitle || 'N/A'}`);
    doc.text(`Deal price: ${formatRupees(dealPrice)}`);
    doc.text(`Success fee: ${feePct != null ? `${feePct}%` : 'N/A'} of deal price`);
    doc.moveDown(0.3).fontSize(14).fillColor('#111').text(`Amount: ${formatRupees(feeAmount)}`);
    doc.moveDown(0.3).fontSize(11).fillColor('#333');
    doc.text(`Invoiced: ${invoicedAt ? new Date(invoicedAt).toLocaleDateString('en-IN') : 'N/A'}`);
    doc.text(`Status: ${collectedAt ? `Paid on ${new Date(collectedAt).toLocaleDateString('en-IN')}` : 'Payment due'}`);

    doc.moveDown(1.5).fontSize(8).fillColor('#999')
      .text('This is a payment receipt, not a GST tax invoice.', { align: 'center' });

    doc.end();
  });
}

// 7.5 — a service-ticket repair/visit charge receipt. Same "simple receipt,
// not a GST tax invoice" scope as buildCommissionReceiptPdf, but a genuinely
// different shape (itemised charges, not a fee % of a deal price) — kept as
// its own function rather than forcing one function to mean two things.
function buildTicketChargeReceiptPdf({ ticketSubject, userName, visitCharge, partsCharge, totalCharge, resolvedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#111').text('RealtyDoor', { align: 'left' });
    doc.fontSize(11).fillColor('#666').text('Service Charge Receipt');
    doc.moveDown(0.5).fontSize(9).fillColor('#999')
      .text(`Ticket: ${ticketSubject || ''}`.trim());

    doc.moveDown(1).fontSize(11).fillColor('#333');
    doc.text(`Billed to: ${userName || 'N/A'}`);
    doc.text(`Visit charge: ${formatRupees(visitCharge)}`);
    doc.text(`Parts/materials: ${formatRupees(partsCharge)}`);
    doc.moveDown(0.3).fontSize(14).fillColor('#111').text(`Total: ${formatRupees(totalCharge)}`);
    doc.moveDown(0.3).fontSize(11).fillColor('#333');
    doc.text(`Resolved: ${resolvedAt ? new Date(resolvedAt).toLocaleDateString('en-IN') : 'N/A'}`);

    doc.moveDown(1.5).fontSize(8).fillColor('#999')
      .text('This is a payment receipt, not a GST tax invoice.', { align: 'center' });

    doc.end();
  });
}

module.exports = { buildCommissionReceiptPdf, buildTicketChargeReceiptPdf };
