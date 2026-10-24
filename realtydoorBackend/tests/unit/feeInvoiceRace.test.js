// BUG-033: two first-time requests for the same payment's invoice used to take two numbers from the series and keep one, leaving a gap
// (tax invoice numbers must be consecutive).
const mockMem = { counters: new Map(), escrow: { id: 'e1', status: 'HELD', processingFeePaise: 120900, razorpayPaymentId: 'pay_X1', lead: { refCode: 'RD-L-000001', buyerName: 'Asha' }, feeInvoiceNo: null, feeInvoiceAt: null } };
jest.mock('../../src/lib/prisma', () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const p = {
    escrowTransaction: {
      findFirst: jest.fn(async () => { await tick(); return { ...mockMem.escrow }; }),
      findUnique: jest.fn(async () => { await tick(); return { ...mockMem.escrow }; }),
      updateMany: jest.fn(async ({ data }) => { await tick(); if (mockMem.escrow.feeInvoiceNo) return { count: 0 }; Object.assign(mockMem.escrow, data); return { count: 1 }; }),
    },
    counter: {
      upsert: jest.fn(async ({ where, create }) => { await tick(); const cur = mockMem.counters.get(where.id); const seq = cur === undefined ? create.seq : cur + 1; mockMem.counters.set(where.id, seq); return { seq }; }),
      create: jest.fn(async ({ data }) => { await tick(); if (mockMem.counters.has(data.id)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } mockMem.counters.set(data.id, data.seq); }),
      findUnique: jest.fn(async ({ where }) => (mockMem.counters.has(where.id) ? { id: where.id, seq: mockMem.counters.get(where.id) } : null)),
      deleteMany: jest.fn(async ({ where }) => { mockMem.counters.delete(where.id); return { count: 1 }; }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    platformConfig: { findMany: jest.fn() },
  };
  return p;
});
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ company: { gstin: '29ABCDE1234F1Z5' }, processingFee: { feeGstPct: 18, sacCode: '9971' } }) }));
jest.mock('../../src/lib/pdfReceipt', () => ({ ...jest.requireActual('../../src/lib/pdfReceipt'), buildFeeTaxInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')) }));

const pdf = require('../../src/lib/pdfReceipt');
const escrow = require('../../src/modules/escrow/escrow.service');

test('five simultaneous first requests: one number is issued, all show it, and the series has no gap', async () => {
  await Promise.all(Array.from({ length: 5 }, () => escrow.getFeeInvoice('e1', 'buyer1')));
  const numbers = new Set(pdf.buildFeeTaxInvoicePdf.mock.calls.map((c) => c[0].invoiceNo));
  expect(numbers.size).toBe(1);
  const series = [...mockMem.counters.entries()].filter(([k]) => k.startsWith('feeInvoice-'));
  expect(series).toHaveLength(1);
  expect(series[0][1]).toBe(1); // only ever one number taken from the series
  expect([...numbers][0]).toMatch(/\/00001$/);
});
