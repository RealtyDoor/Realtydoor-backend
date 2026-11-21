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
// With Razorpay's Customer Fee Bearer the buyer's card was also charged Razorpay's own gateway charge, which Realtydoor never receives: the last line then
// says what was paid TO REALTYDOOR, and a line says who collected the gateway charge, so the receipt never under-states what the card was charged.
// The company name in the receipt header, on ONE line: the full legal name at 20pt wrapped onto the blue rule (seen 21 Nov 2026),
// so the size steps down until it fits the space left of the document title.
function companyName(doc, name, left, width, color) {
  const box = width * 0.62;
  let size = 20;
  doc.font('Helvetica-Bold');
  while (size > 12 && doc.fontSize(size).widthOfString(name) > box) size -= 1;
  doc.fontSize(size).fillColor(color).text(name, left, 50 + (20 - size) / 2, { width: box, lineBreak: false });
}

function escrowReceiptLines({ amount, processingFeePaise, chargedPaise, feeBearer, gatewayChargePaise = null }) {
  const rs = rsPaise;
  const tokenPaise = Math.round((amount || 0) * 100);
  const feePaise = processingFeePaise > 0 ? processingFeePaise : 0;
  const totalPaise = chargedPaise > 0 ? chargedPaise : tokenPaise + feePaise;
  const customer = feeBearer === 'CUSTOMER' && !feePaise;
  return [
    { label: 'Token advance', value: rs(tokenPaise) },
    ...(feePaise ? [{ label: 'Payment processing fee (GST included)', value: rs(feePaise) }] : []),
    // The amount when it is known (recorded since 21 Nov 2026), so the buyer sees what the card was charged in all.
    ...(customer ? [{ label: 'Payment gateway charge', value: Number.isInteger(gatewayChargePaise) && gatewayChargePaise > 0 ? `${rs(gatewayChargePaise)}, paid to Razorpay` : 'Collected by Razorpay' }] : []),
    { label: customer ? 'Paid to Realtydoor' : 'Total paid', value: rs(totalPaise), strong: true },
  ];
}

/** The paragraph under the amounts on the token receipt. The fee sentence follows THIS payment: only when a fee was charged. With Razorpay's
 *  Customer Fee Bearer there is no fee of ours, and it says who collects the gateway's charge. */
function escrowReceiptNote({ processingFeePaise, feeBearer }) {
  const feeSentence = processingFeePaise > 0
    ? 'The payment processing fee covers the payment company\'s charge and is not returned if you cancel.'
    : (feeBearer === 'CUSTOMER'
      ? 'Realtydoor adds no fee to this payment. Any payment-gateway charge was shown and collected by Razorpay at checkout, and appears on Razorpay\'s own confirmation.'
      : '');
  return `Your token advance is held in escrow with our payment partner until your allocation letter is verified.${feeSentence ? ` ${feeSentence}` : ''}`;
}

/** The receipt number shown on the PDF and in the email: RCT- plus the last 8 characters of the Razorpay payment id. */
const receiptNumber = (razorpayPaymentId) => (razorpayPaymentId ? `RCT-${String(razorpayPaymentId).replace(/^pay_/, '').slice(-8).toUpperCase()}` : 'RCT-N/A');

function buildEscrowReceiptPdf({ refCode, propertyTitle, buyerName, amount, processingFeePaise, chargedPaise, razorpayPaymentId, paidAt, company = {}, feeBearer, gatewayChargePaise = null }) {
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
    const receiptNo = receiptNumber(razorpayPaymentId);

    // Header: name on the left, document title on the right, a brand rule under both.
    companyName(doc, legalName, left, width, INK);
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
    for (const line of escrowReceiptLines({ amount, processingFeePaise, chargedPaise, feeBearer, gatewayChargePaise })) {
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
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(escrowReceiptNote({ processingFeePaise, feeBearer }), left, y, { width });

    // Footer.
    const footerY = doc.page.height - 90;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${legalName}${company.gstin ? `  |  GSTIN ${company.gstin}` : ''}`, left, footerY + 10, { width, align: 'center' })
      .text(company.gstin && processingFeePaise > 0 ? 'This is a payment receipt. The GST tax invoice for the processing fee is a separate document.' : 'This is a payment receipt, not a GST tax invoice.', left, footerY + 24, { width, align: 'center' });

    doc.end();
  });
}

// Refund receipt: what the buyer paid, what was kept (the cancellation charge, and the processing fee unless it came back too),
// and what returned to the original payment method. Same plain layout as the token receipt.
// Payment audit 21 Nov 2026 (Customer Fee Bearer): with no fee of ours, Razorpay's own charge (when known) is shown as paid to
// Razorpay and not returned, so the receipt matches what the card was charged.
function refundReceiptLines({ tokenPaise, feePaise, refundedPaise, chargePaise, gatewayChargePaise = null }) {
  const rs = rsPaise;
  const fee = feePaise > 0 ? feePaise : 0;
  const feeReturned = fee > 0 && refundedPaise > tokenPaise;
  const gateway = !fee && Number.isInteger(gatewayChargePaise) && gatewayChargePaise > 0 ? gatewayChargePaise : 0;
  return [
    { label: 'Token advance paid', value: rs(tokenPaise) },
    ...(gateway ? [{ label: "Razorpay's payment-gateway charge (paid to Razorpay, not returned)", value: rs(gateway) }] : []),
    ...(chargePaise > 0 ? [{ label: 'Cancellation charge kept', value: `- ${rs(chargePaise)}` }] : []),
    ...(fee ? [{ label: feeReturned ? 'Payment processing fee (returned)' : 'Payment processing fee (not returned)', value: feeReturned ? rs(fee) : '-' }] : []),
    { label: 'Refunded to your original payment method', value: rs(refundedPaise), strong: true },
  ];
}

function buildRefundReceiptPdf({ refCode, propertyTitle, buyerName, tokenPaise, feePaise, refundedPaise, chargePaise, razorpayRefundId, refundedAt, company = {}, gatewayChargePaise = null }) {
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
    const receiptNo = razorpayRefundId ? `RFN-${String(razorpayRefundId).replace(/^rfnd_/, '').slice(-8).toUpperCase()}` : 'RFN-N/A';

    companyName(doc, legalName, left, width, INK);
    doc.fontSize(10).fillColor(BRAND).font('Helvetica-Bold').text('REFUND RECEIPT', left, 56, { width, align: 'right' });
    doc.moveTo(left, 88).lineTo(right, 88).lineWidth(2).strokeColor(BRAND).stroke();

    const meta = [
      ['Receipt no.', receiptNo],
      ['Date', refundedAt ? new Date(refundedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A'],
      ['Deal reference', refCode || 'N/A'],
      ['Refunded to', buyerName || 'N/A'],
      ['Property', propertyTitle || 'N/A'],
      ['Refund reference', razorpayRefundId || 'N/A'],
    ];
    let y = 108;
    doc.font('Helvetica').fontSize(10);
    for (const [label, value] of meta) {
      doc.fillColor(MUTED).text(label, left, y, { width: 120 });
      doc.fillColor(INK).text(value, left + 130, y, { width: width - 130 });
      y = Math.max(y + 16, doc.y + 4);
    }

    y += 14;
    doc.rect(left, y, width, 24).fill('#F3F4F8');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
      .text('DESCRIPTION', left + 10, y + 8, { width: width - 130 })
      .text('AMOUNT', left, y + 8, { width: width - 10, align: 'right' });
    y += 24;
    for (const line of refundReceiptLines({ tokenPaise, feePaise, refundedPaise, chargePaise, gatewayChargePaise })) {
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
      'The refund goes back to the payment method you used. Your bank may take a few days to show it. If you think we made a mistake, raise a request from your Realtydoor account.',
      left, y, { width },
    );

    const footerY = doc.page.height - 90;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${legalName}${company.gstin ? `  |  GSTIN ${company.gstin}` : ''}`, left, footerY + 10, { width, align: 'center' })
      .text('This is a refund receipt, not a GST document.', left, footerY + 24, { width, align: 'center' });

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

    companyName(doc, legalName, left, width, INK);
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

// The money lines of a service receipt. The price the buyer paid already includes GST, so the lines show the amount before GST,
// the GST inside it, and the total (what the card was charged).
// Under Razorpay's Customer Fee Bearer the card was also charged Razorpay's own fee (never ours), so the last line is what Realtydoor received.
function serviceReceiptLines({ amountPaise, gstPct = 18, feeBearer }) {
  const gstPaise = amountPaise - Math.round(amountPaise / (1 + gstPct / 100));
  const customer = feeBearer === 'CUSTOMER';
  return [
    { label: 'Service fee before GST', value: rsPaise(amountPaise - gstPaise) },
    { label: `GST at ${gstPct}% (included in the price)`, value: rsPaise(gstPaise) },
    ...(customer ? [{ label: 'Payment gateway charge', value: 'Collected by Razorpay' }] : []),
    { label: customer ? 'Paid to Realtydoor' : 'Total paid', value: rsPaise(amountPaise), strong: true },
  ];
}

function buildServiceReceiptPdf({ serviceName, buyerName, amountPaise, gstPct = 18, razorpayPaymentId, paidAt, validUntil, company = {}, feeBearer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50; const right = doc.page.width - 50; const width = right - left;
    const INK = '#111111'; const BODY = '#333333'; const MUTED = '#777777'; const RULE = '#DDDDDD'; const BRAND = '#2C2FEE';
    const legalName = company.legalName || 'RealtyDoor';
    const receiptNo = razorpayPaymentId ? `SRV-${String(razorpayPaymentId).replace(/^pay_/, '').slice(-8).toUpperCase()}` : 'SRV-N/A';
    const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A');

    companyName(doc, legalName, left, width, INK);
    doc.fontSize(10).fillColor(BRAND).font('Helvetica-Bold').text('SERVICE PAYMENT RECEIPT', left, 56, { width, align: 'right' });
    doc.moveTo(left, 88).lineTo(right, 88).lineWidth(2).strokeColor(BRAND).stroke();

    const meta = [
      ['Receipt no.', receiptNo], ['Date', day(paidAt)], ['Paid by', buyerName || 'N/A'], ['Service', serviceName || 'N/A'],
      ['Valid until', day(validUntil)], ['Payment reference', razorpayPaymentId || 'N/A'],
    ];
    let y = 108;
    doc.font('Helvetica').fontSize(10);
    for (const [label, value] of meta) {
      doc.fillColor(MUTED).text(label, left, y, { width: 120 });
      doc.fillColor(INK).text(value, left + 130, y, { width: width - 130 });
      y = Math.max(y + 16, doc.y + 4);
    }

    y += 14;
    doc.rect(left, y, width, 24).fill('#F3F4F8');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
      .text('DESCRIPTION', left + 10, y + 8, { width: width - 130 })
      .text('AMOUNT', left, y + 8, { width: width - 10, align: 'right' });
    y += 24;
    for (const line of serviceReceiptLines({ amountPaise, gstPct, feeBearer })) {
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

    const footerY = doc.page.height - 90;
    doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${legalName}${company.gstin ? `  |  GSTIN ${company.gstin}` : ''}`, left, footerY + 10, { width, align: 'center' })
      .text('This is a payment receipt, not a GST tax invoice.', left, footerY + 24, { width, align: 'center' });
    doc.end();
  });
}

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

module.exports = { escrowReceiptNote, receiptNumber, serviceReceiptLines, buildServiceReceiptPdf, feeTaxInvoiceRows, buildFeeTaxInvoicePdf, escrowReceiptLines, buildPartnerStatementPdf, buildCommissionReceiptPdf, buildTicketChargeReceiptPdf, buildEscrowReceiptPdf, buildRefundReceiptPdf, refundReceiptLines };
