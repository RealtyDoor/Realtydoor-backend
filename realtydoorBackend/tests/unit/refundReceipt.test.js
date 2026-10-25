// BUG-M11 (25 Oct 2026): a refunded payment only had the original receipt. It now has a refund receipt that says what came back,
// what was kept (cancellation charge, processing fee) and the refund reference.
jest.mock('../../src/lib/prisma', () => ({ escrowTransaction: { findFirst: jest.fn() }, lead: { findUnique: jest.fn() }, user: { findUnique: jest.fn() } }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ company: { legalName: 'Test Co' } }) }));

const prisma = require('../../src/lib/prisma');
const { refundReceiptLines, buildRefundReceiptPdf } = require('../../src/lib/pdfReceipt');
const svc = require('../../src/modules/escrow/escrow.service');

describe('refundReceiptLines', () => {
  test('inside the window: token back in full, fee kept, no charge line', () => {
    const l = refundReceiptLines({ tokenPaise: 5_000_000, feePaise: 120_900, refundedPaise: 5_000_000, chargePaise: 0 });
    expect(l.map((x) => x.label)).toEqual(['Token advance paid', 'Payment processing fee (not returned)', 'Refunded to your original payment method']);
    expect(l[2]).toMatchObject({ value: 'Rs. 50,000', strong: true });
  });
  test('after the window: the cancellation charge is shown and the refund is the rest', () => {
    const l = refundReceiptLines({ tokenPaise: 5_000_000, feePaise: 120_900, refundedPaise: 4_700_100, chargePaise: 299_900 });
    expect(l.map((x) => x.label)).toContain('Cancellation charge kept');
    expect(l.find((x) => x.label === 'Cancellation charge kept').value).toBe('- Rs. 2,999');
    expect(l[l.length - 1].value).toBe('Rs. 47,001');
  });
  test('a fault refund returns the fee too', () => {
    const l = refundReceiptLines({ tokenPaise: 5_000_000, feePaise: 120_900, refundedPaise: 5_120_900, chargePaise: 0 });
    expect(l.map((x) => x.label)).toContain('Payment processing fee (returned)');
    expect(l[l.length - 1].value).toBe('Rs. 51,209');
  });
});

describe('buildRefundReceiptPdf', () => {
  test('makes a PDF', async () => {
    const buf = await buildRefundReceiptPdf({ refCode: 'RD-L-000103', propertyTitle: 'Vrunda City', buyerName: 'Krishna', tokenPaise: 5_000_000, feePaise: 120_900, refundedPaise: 5_000_000, chargePaise: 0, razorpayRefundId: 'rfnd_ABC12345', refundedAt: new Date(), company: { legalName: 'Test Co' } });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('getRefundReceipt', () => {
  const refunded = { id: 'e1', buyerId: 'b1', status: 'REFUNDED', amount: 50000, processingFeePaise: 120_900, refundedAmountPaise: 5_000_000, cancellationChargePaise: null, razorpayRefundId: 'rfnd_1', refundedAt: new Date(), lead: { refCode: 'RD-L-1', buyerName: 'K', property: { title: 'P' } } };
  test('someone else\'s or a missing escrow is a 404', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    await expect(svc.getRefundReceipt('e1', 'other')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('a payment that was not refunded has no refund receipt', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ ...refunded, status: 'HELD' });
    await expect(svc.getRefundReceipt('e1', 'b1')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a refunded payment gives a PDF', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(refunded);
    const buf = await svc.getRefundReceipt('e1', 'b1');
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(prisma.escrowTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'e1', buyerId: 'b1' } }));
  });
});
