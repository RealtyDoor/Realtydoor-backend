const PDFDocument = require('pdfkit');

// R26 — a simple payment receipt for the owner's success fee: confirms the
// amount and that it was paid, no GST breakup (no GSTIN/HSN/CGST-SGST split
// — deliberately out of scope until the business is ready to issue a real
// tax invoice; upgrading this later doesn't require touching the Lead
// fields that reference it, only this file).
// PDFKit's built-in Helvetica has no rupee sign (U+20B9): it prints a superscript 1 ("¹50,000"). "Rs." is the standard
// way to write rupees on a printed document and needs no embedded font.
function rsPaise(paise, minFraction) {
  const min = minFraction ?? (paise % 100 ? 2 : 0);
  return `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: min, maximumFractionDigits: 2 })}`;
}

function formatRupees(amount) {
  if (amount == null) return 'N/A';
  return `Rs. ${Math.round(amount).toLocaleString('en-IN')}`;
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
// The money lines of the token receipt, in rupees with paise where there are some. The buyer paid the token PLUS the
// payment processing fee (money model Rev 3), so the receipt shows both and the total, not just the token.
function escrowReceiptLines({ amount, processingFeePaise, chargedPaise }) {
  const rs = rsPaise;
  const tokenPaise = Math.round((amount || 0) * 100);
  const feePaise = processingFeePaise > 0 ? processingFeePaise : 0;
  const totalPaise = chargedPaise > 0 ? chargedPaise : tokenPaise + feePaise;
  return [
    { label: 'Token advance', value: rs(tokenPaise) },
    ...(feePaise ? [{ label: 'Payment processing fee (GST included)', value: rs(feePaise) }] : []),
    { label: 'Total paid', value: rs(totalPaise), strong: true },
  ];
}

function buildEscrowReceiptPdf({ refCode, propertyTitle, buyerName, amount, processingFeePaise, chargedPaise, razorpayPaymentId, paidAt, company = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const INK = '#111111'; const BODY = '#333333'; const MUTED = '#777777'; const RULE = '#DDDDDD'; const BRAND = '#2C2FEE';
    const legalName = company.legalName || 'RealtyDoor';
    const receiptNo = razorpayPaymentId ? `RCT-${String(razorpayPaymentId).replace(/^pay_/, '').slice(-8).toUpperCase()}` : 'RCT-N/A';

    // Header: name on the left, document title on the right, a brand rule under both.
    doc.fontSize(20).fillColor(INK).font('Helvetica-Bold').text(legalName, left, 50, { width: width * 0.6 });
    doc.fontSize(10).fillColor(BRAND).font('Helvetica-Bold').text('TOKEN ADVANCE RECEIPT', left, 56, { width, align: 'right' });
    doc.moveTo(left, 88).lineTo(right, 88).lineWidth(2).strokeColor(BRAND).stroke();

    // Who, what, when.
    const meta = [
      ['Receipt no.', receiptNo],
      ['Date', paidAt ? new Date(paidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A'],
      ['Deal reference', refCode || 'N/A'],
      ['Paid by', buyerName || 'N/A'],
      ['Property', propertyTitle || 'N/A'],
      ['Payment reference', razorpayPaymentId || 'N/A'],
    ];
    let y = 108;
    doc.font('Helvetica').fontSize(10);
    for (const [label, value] of meta) {
      doc.fillColor(MUTED).text(label, left, y, { width: 120 });
      doc.fillColor(INK).text(value, left + 130, y, { width: width - 130 });
      y = Math.max(y + 16, doc.y + 4);
    }

    // The money, as a table: description left, amount right, total last.
    y += 14;
    doc.rect(left, y, width, 24).fill('#F3F4F8');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
      .text('DESCRIPTION', left + 10, y + 8, { width: width - 130 })
      .text('AMOUNT', left, y + 8, { width: width - 10, align: 'right' });
    y += 24;
    for (const line of escrowReceiptLines({ amount, processingFeePaise, chargedPaise })) {
      if (line.strong) {
        doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
        doc.rect(left, y, width, 30).fill('#F3F4F8');
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
          .text(line.label, left + 10, y + 9, { width: width - 130 })
          .text(line.value, left, y + 9, { width: width - 10, align: 'right' });
        y += 30;
      } else {
        doc.fillColor(BODY).font('Helvetica').fontSize(11)
          .text(line.label, left + 10, y + 9, { width: width - 130 })
          .text(line.value, left, y + 9, { width: width - 10, align: 'right' });
        y += 30;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
      }
    }

    // What it means.
    y += 22;
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(
      'Your token advance is held in escrow with our payment partner until your allocation letter is verified. '
      + 'The payment processing fee covers the payment company\'s charge and is not returned if you cancel.',
      left, y, { width },
    );

    // Footer.
    const footerY = doc.page.height - 90;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${legalName}${company.gstin ? `  |  GSTIN ${company.gstin}` : ''}`, left, footerY + 10, { width, align: 'center' })
      .text(company.gstin ? 'This is a payment receipt. The GST tax invoice for the processing fee is a separate document.' : 'This is a payment receipt, not a GST tax invoice.', left, footerY + 24, { width, align: 'center' });

    doc.end();
  });
}

// GST tax invoice for the buyer's processing fee (T62). Lines come from lib/gstInvoice.js's splitGstInclusive (all paise).
// `rows` is pure data so a test can check the numbers without parsing a PDF.
function feeTaxInvoiceRows({ split, gstPct, sacCode }) {
  const rs = (paise) => rsPaise(paise, 2);
  return [
    { label: `Payment processing fee${sacCode ? ` (SAC ${sacCode})` : ''}, taxable value`, value: rs(split.taxablePaise) },
    { label: `CGST @ ${gstPct / 2}%`, value: rs(split.cgstPaise) },
    { label: `SGST @ ${gstPct / 2}%`, value: rs(split.sgstPaise) },
    { label: 'Invoice total', value: rs(split.totalPaise), strong: true },
  ];
}

function buildFeeTaxInvoicePdf({ company = {}, invoiceNo, invoiceDate, buyerName, refCode, razorpayPaymentId, split, gstPct = 18, sacCode }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const INK = '#111111'; const BODY = '#333333'; const MUTED = '#777777'; const RULE = '#DDDDDD'; const BRAND = '#2C2FEE';
    const legalName = company.legalName || 'RealtyDoor';

    doc.fontSize(20).fillColor(INK).font('Helvetica-Bold').text(legalName, left, 50, { width: width * 0.6 });
    doc.fontSize(10).fillColor(BRAND).font('Helvetica-Bold').text('TAX INVOICE', left, 56, { width, align: 'right' });
    doc.moveTo(left, 88).lineTo(right, 88).lineWidth(2).strokeColor(BRAND).stroke();

    const meta = [
      ['Invoice no.', invoiceNo],
      ['Invoice date', new Date(invoiceDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })],
      ['Supplier', legalName],
      ['Supplier GSTIN', company.gstin || 'N/A'],
      ...(company.address ? [['Supplier address', company.address]] : []),
      ['Billed to', buyerName || 'N/A'],
      ['Deal reference', refCode || 'N/A'],
      ['Payment reference', razorpayPaymentId || 'N/A'],
      ['Place of supply', "Supplier's location (buyer address not recorded)"],
    ];
    let y = 108;
    doc.font('Helvetica').fontSize(10);
    for (const [label, value] of meta) {
      doc.fillColor(MUTED).text(label, left, y, { width: 120 });
      doc.fillColor(INK).text(value, left + 130, y, { width: width - 130 });
      y += Math.max(18, doc.heightOfString(String(value), { width: width - 130 }) + 4);
    }

    y += 14;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
    for (const line of feeTaxInvoiceRows({ split, gstPct, sacCode })) {
      if (line.strong) {
        doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
        doc.rect(left, y, width, 30).fill('#F3F4F8');
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
          .text(line.label, left + 10, y + 9, { width: width - 130 })
          .text(line.value, left, y + 9, { width: width - 10, align: 'right' });
        y += 30;
      } else {
        doc.fillColor(BODY).font('Helvetica').fontSize(11)
          .text(line.label, left + 10, y + 9, { width: width - 130 })
          .text(line.value, left, y + 9, { width: width - 10, align: 'right' });
        y += 30;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
      }
    }

    y += 22;
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(
      'This invoice is for the payment processing fee only. The token advance is held in escrow for the seller and is covered by the token advance receipt.',
      left, y, { width },
    );

    const footerY = doc.page.height - 90;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${legalName}${company.gstin ? `  |  GSTIN ${company.gstin}` : ''}`, left, footerY + 10, { width, align: 'center' })
      .text('This is a computer-generated invoice and needs no signature.', left, footerY + 24, { width, align: 'center' });

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
    const rs = (paise) => (paise == null ? 'N/A' : rsPaise(paise, 2));

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

module.exports = { feeTaxInvoiceRows, buildFeeTaxInvoicePdf, escrowReceiptLines, buildPartnerStatementPdf, buildCommissionReceiptPdf, buildTicketChargeReceiptPdf, buildEscrowReceiptPdf };
