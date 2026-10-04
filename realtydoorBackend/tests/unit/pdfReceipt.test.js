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
