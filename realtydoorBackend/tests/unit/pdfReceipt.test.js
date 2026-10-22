const { buildCommissionReceiptPdf, buildTicketChargeReceiptPdf } = require('../../src/lib/pdfReceipt');

describe('buildCommissionReceiptPdf', () => {
  test('produces a real PDF buffer', async () => {
    const buffer = await buildCommissionReceiptPdf({
      refCode: 'RD-L-000123', propertyTitle: 'Test Flat', payerName: 'Test Owner',
      feePct: 2, dealPrice: 9000000, feeAmount: 180000,
      invoicedAt: new Date('2026-01-01'), collectedAt: null,
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(100);
  });

  test('does not throw when every field is missing', async () => {
    const buffer = await buildCommissionReceiptPdf({});
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('buildTicketChargeReceiptPdf', () => {
  test('produces a real PDF buffer', async () => {
    const buffer = await buildTicketChargeReceiptPdf({
      ticketSubject: 'Leaking pipe', userName: 'Test User',
      visitCharge: 500, partsCharge: 1000, totalCharge: 1500, resolvedAt: new Date('2026-01-01'),
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('escrowReceiptLines (the buyer paid the token plus the processing fee)', () => {
  const { escrowReceiptLines, buildEscrowReceiptPdf } = require('../../src/lib/pdfReceipt');
  test('shows token, fee and the total actually charged', () => {
    expect(escrowReceiptLines({ amount: 50000, processingFeePaise: 120900, chargedPaise: 5120900 })).toEqual([
      { label: 'Token advance', value: 'Rs. 50,000' },
      { label: 'Payment processing fee (GST included)', value: 'Rs. 1,209' },
      { label: 'Total paid', value: 'Rs. 51,209', strong: true },
    ]);
  });
  test('paise are shown when there are some', () => {
    expect(escrowReceiptLines({ amount: 50000, processingFeePaise: 120950 })[2].value).toBe('Rs. 51,209.50');
  });
  test('an old escrow with no fee shows just the token as the total', () => {
    expect(escrowReceiptLines({ amount: 50000 })).toEqual([
      { label: 'Token advance', value: 'Rs. 50,000' },
      { label: 'Total paid', value: 'Rs. 50,000', strong: true },
    ]);
  });
  test('still produces a PDF', async () => {
    const buf = await buildEscrowReceiptPdf({ refCode: 'RD-L-1', amount: 50000, processingFeePaise: 120900, chargedPaise: 5120900, paidAt: new Date() });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('PDF currency symbol', () => {
  test("no PDF uses the rupee sign: PDFKit's built-in font prints it as a superscript 1", () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/lib/pdfReceipt.js'), 'utf8');
    expect(src.includes('₹')).toBe(false);
  });
  test('the receipt names the company and prints its GSTIN when set', async () => {
    const { buildEscrowReceiptPdf } = require('../../src/lib/pdfReceipt');
    const withCompany = await buildEscrowReceiptPdf({ company: { legalName: 'Realtydoor Pvt Ltd', gstin: '29ABCDE1234F1Z5' }, amount: 50000, razorpayPaymentId: 'pay_ABC12345', paidAt: new Date() });
    expect(withCompany.subarray(0, 4).toString()).toBe('%PDF');
    expect(withCompany.length).toBeGreaterThan(1000);
  });
});

describe('ticket charge receipt (T12)', () => {
  test('is for the parts only: no visit charge on it', async () => {
    const { buildTicketChargeReceiptPdf } = require('../../src/lib/pdfReceipt');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/lib/pdfReceipt.js'), 'utf8');
    expect(/Visit charge/i.test(src)).toBe(false);
    const buf = await buildTicketChargeReceiptPdf({ ticketSubject: 'Leak', userName: 'U', partsCharge: 300, totalCharge: 300, resolvedAt: new Date() });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
