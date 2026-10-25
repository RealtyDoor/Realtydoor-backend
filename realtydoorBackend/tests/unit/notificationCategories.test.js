// Found live on 25 Oct 2026: "Token received" (ESCROW_HELD) landed under System, so the admin Escrow tab missed it.
jest.mock('../../src/lib/prisma', () => ({}));
const { categoryFor } = require('../../src/lib/notifications');

describe('notification categories for the money events', () => {
  test.each([
    ['ESCROW_HELD', 'ESCROW'], ['ESCROW_RELEASED', 'ESCROW'], ['ESCROW_REFUNDED', 'ESCROW'],
    ['TAX_INVOICE_UPLOADED', 'FEES'], ['TAX_INVOICE_ACCEPTED', 'FEES'], ['TAX_INVOICE_REJECTED', 'FEES'],
    ['COMMISSION_VOUCHER', 'FEES'], ['COMMISSION_VOUCHER_READY', 'FEES'],
  ])('%s is under %s', (type, cat) => expect(categoryFor(type)).toBe(cat));
});
