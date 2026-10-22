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

// Dev feedback, 2026-10-08 — the buyer's token-advance receipt had no
// backend endpoint at all; the frontend's "receipt" was a browser print of
// the on-screen summary. Same "simple receipt, not a GST tax invoice"
// scope as the other two.
function buildEscrowReceiptPdf({ refCode, propertyTitle, buyerName, amount, razorpayPaymentId, paidAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#111').text('RealtyDoor', { align: 'left' });
    doc.fontSize(11).fillColor('#666').text('Token Advance Receipt');
    doc.moveDown(0.5).fontSize(9).fillColor('#999')
      .text(`Receipt for lead ${refCode || ''}`.trim());

    doc.moveDown(1).fontSize(11).fillColor('#333');
    doc.text(`Paid by: ${buyerName || 'N/A'}`);
    doc.text(`Property: ${propertyTitle || 'N/A'}`);
    doc.moveDown(0.3).fontSize(14).fillColor('#111').text(`Amount paid: ${formatRupees(amount)}`);
    doc.moveDown(0.3).fontSize(11).fillColor('#333');
    doc.text(`Payment reference: ${razorpayPaymentId || 'N/A'}`);
    doc.text(`Paid on: ${paidAt ? new Date(paidAt).toLocaleDateString('en-IN') : 'N/A'}`);

    doc.moveDown(1.5).fontSize(8).fillColor('#999')
      .text('This is a payment receipt, not a GST tax invoice.', { align: 'center' });

    doc.end();
  });
}

// Partner statement for one deal (money model Rev 3, section 2.6a): commission,
// GST (registered partners only), TDS, net, bank reference, date.
function buildPartnerStatementPdf(st) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const rs = (paise) => (paise == null ? 'N/A' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

    doc.fontSize(20).fillColor('#111').text(st.legalName || 'RealtyDoor');
    doc.fontSize(11).fillColor('#666').text('Partner commission statement');
    doc.moveDown(0.5).fontSize(9).fillColor('#999').text(`Deal ${st.dealRef || ''}  ${st.propertyTitle || ''}`.trim());
    doc.moveDown(1).fontSize(11).fillColor('#333');
    doc.text(`Partner: ${st.partner?.name || 'N/A'}`);
    doc.text(`Deal price: ${rs(st.dealPricePaise)}`);
    doc.text(`Commission rate: ${st.ratePct != null ? `${st.ratePct}% of the deal price${st.isCustomRate ? ' (custom rate)' : ''}` : 'N/A'}`);
    doc.moveDown(0.5);
    doc.text(`Commission: ${rs(st.commissionPaise)}`);
    if (st.gstRegistered) doc.text(`GST (paid after your tax invoice is matched in our GST return): ${rs(st.gstPaise)}`);
    if (st.tds) doc.text(`TDS ${st.tds.ratePct}% (${st.tds.section}) withheld: - ${rs(st.tds.paise)}`);
    doc.moveDown(0.3).fontSize(14).fillColor('#111').text(`Paid to your bank: ${rs(st.netPaise)}`);
    doc.moveDown(0.3).fontSize(11).fillColor('#333');
    doc.text(`Bank reference (UTR): ${st.bankReference || 'N/A'}`);
    doc.text(`Date: ${st.date ? new Date(st.date).toLocaleDateString('en-IN') : 'N/A'}`);
    doc.text(`Document: ${st.document?.type === 'TAX_INVOICE' ? `Tax invoice ${st.document.invoiceNumber || ''} (${st.document.status})` : `Commission voucher ${st.document?.voucherNumber || ''} (${st.document?.status || 'N/A'})`}`);
    doc.moveDown(1.5).fontSize(8).fillColor('#999')
      .text('TDS withheld is deposited under your PAN and shows in Form 26AS; a certificate (Form 16A) is issued each quarter.', { align: 'center' });
    doc.end();
  });
}

module.exports = { buildPartnerStatementPdf, buildCommissionReceiptPdf, buildTicketChargeReceiptPdf, buildEscrowReceiptPdf };
