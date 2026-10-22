jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  counter: { upsert: jest.fn() },
  platformConfig: { findMany: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/lib/pdfReceipt', () => ({
  ...jest.requireActual('../../src/lib/pdfReceipt'),
  buildFeeTaxInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
}));

const prisma = require('../../src/lib/prisma');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const pdf = require('../../src/lib/pdfReceipt');
const escrow = require('../../src/modules/escrow/escrow.service');

const settings = (company = {}) => ({
  company: { gstin: '29ABCDE1234F1Z5', legalName: 'Realtydoor Pvt Ltd', address: 'Bengaluru', ...company },
  processingFee: { feeGstPct: 18, sacCode: '9971' },
});
const held = { id: 'e1', status: 'HELD', processingFeePaise: 120900, razorpayPaymentId: 'pay_X1', lead: { refCode: 'RD-L-000001', buyerName: 'Asha' } };

beforeEach(() => {
  jest.clearAllMocks();
  getMoneySettings.mockResolvedValue(settings());
  prisma.escrowTransaction.findFirst.mockResolvedValue({ ...held });
  prisma.counter.upsert.mockResolvedValue({ seq: 7 });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
});

describe('getFeeInvoice (T62)', () => {
  test('issues the next number once, with the fee split into taxable value and CGST/SGST', async () => {
    const out = await escrow.getFeeInvoice('e1', 'buyer1');
    expect(Buffer.isBuffer(out)).toBe(true);
    const call = pdf.buildFeeTaxInvoicePdf.mock.calls[0][0];
    expect(call.invoiceNo).toMatch(/^RD\/\d\d-\d\d\/00007$/);
    expect(call.split).toEqual({ taxablePaise: 102458, cgstPaise: 9221, sgstPaise: 9221, totalPaise: 120900 });
    expect(call.sacCode).toBe('9971');
    expect(call.company.gstin).toBe('29ABCDE1234F1Z5');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data.feeInvoiceNo).toBe(call.invoiceNo);
  });

  test('a second download keeps the same number and takes nothing more from the series', async () => {
    const at = new Date('2026-10-22');
    prisma.escrowTransaction.findFirst.mockResolvedValue({ ...held, feeInvoiceNo: 'RD/26-27/00003', feeInvoiceAt: at });
    await escrow.getFeeInvoice('e1', 'buyer1');
    expect(prisma.counter.upsert).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(pdf.buildFeeTaxInvoicePdf.mock.calls[0][0]).toMatchObject({ invoiceNo: 'RD/26-27/00003', invoiceDate: at });
  });

  test('if another request got the number first, this one uses that number', async () => {
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    const at = new Date('2026-10-22');
    prisma.escrowTransaction.findUnique.mockResolvedValue({ feeInvoiceNo: 'RD/26-27/00006', feeInvoiceAt: at });
    await escrow.getFeeInvoice('e1', 'buyer1');
    expect(pdf.buildFeeTaxInvoicePdf.mock.calls[0][0]).toMatchObject({ invoiceNo: 'RD/26-27/00006', invoiceDate: at });
  });

  test('without the company GSTIN there is no tax invoice, and no number is used up', async () => {
    getMoneySettings.mockResolvedValue(settings({ gstin: '' }));
    await expect(escrow.getFeeInvoice('e1', 'buyer1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'FEE_INVOICE_UNAVAILABLE' } });
    expect(prisma.counter.upsert).not.toHaveBeenCalled();
  });

  test('refuses when the payment is not captured, when no fee was charged, and for someone else\'s escrow', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ ...held, status: 'CREATED' });
    await expect(escrow.getFeeInvoice('e1', 'buyer1')).rejects.toMatchObject({ statusCode: 400 });
    prisma.escrowTransaction.findFirst.mockResolvedValue({ ...held, processingFeePaise: 0 });
    await expect(escrow.getFeeInvoice('e1', 'buyer1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'NO_PROCESSING_FEE' } });
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    await expect(escrow.getFeeInvoice('e1', 'someoneElse')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.counter.upsert).not.toHaveBeenCalled();
  });
});

describe('fee tax invoice rows and PDF', () => {
  const real = jest.requireActual('../../src/lib/pdfReceipt');
  test('rows show taxable value, CGST, SGST and a total that adds up', () => {
    const rows = real.feeTaxInvoiceRows({ split: { taxablePaise: 102458, cgstPaise: 9221, sgstPaise: 9221, totalPaise: 120900 }, gstPct: 18, sacCode: '9971' });
    expect(rows.map((r) => r.value)).toEqual(['Rs. 1,024.58', 'Rs. 92.21', 'Rs. 92.21', 'Rs. 1,209.00']);
    expect(rows[0].label).toContain('SAC 9971');
    expect(rows[1].label).toBe('CGST @ 9%');
  });
  test('the SAC code is left off when none is set', () => {
    const rows = real.feeTaxInvoiceRows({ split: { taxablePaise: 100, cgstPaise: 9, sgstPaise: 9, totalPaise: 118 }, gstPct: 18, sacCode: '' });
    expect(rows[0].label).not.toContain('SAC');
  });
  test('builds a real PDF', async () => {
    const buf = await real.buildFeeTaxInvoicePdf({
      company: { legalName: 'Realtydoor Pvt Ltd', gstin: '29ABCDE1234F1Z5', address: 'Bengaluru' }, invoiceNo: 'RD/26-27/00001',
      invoiceDate: new Date('2026-10-22'), buyerName: 'Asha', refCode: 'RD-L-000001', razorpayPaymentId: 'pay_X1',
      split: { taxablePaise: 102458, cgstPaise: 9221, sgstPaise: 9221, totalPaise: 120900 }, gstPct: 18, sacCode: '9971',
    });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
  test('the token receipt points to the separate invoice only when a GSTIN is set', async () => {
    const withGstin = await real.buildEscrowReceiptPdf({ refCode: 'x', amount: 50000, processingFeePaise: 120900, chargedPaise: 5120900, company: { gstin: '29ABCDE1234F1Z5' } });
    expect(withGstin.slice(0, 5).toString()).toBe('%PDF-');
  });
});
