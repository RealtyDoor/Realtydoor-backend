const { presentTicketForBuyer } = require('../../src/lib/ticketPresenter');

describe('presentTicketForBuyer', () => {
  test('adds buyer-facing names for the charge breakdown, receipt and resolution note', () => {
    const out = presentTicketForBuyer({
      id: 't1', visitCharge: 300, partsCharge: 700, totalCharge: 1000,
      invoiceUrl: 'https://x/receipt.pdf', resolutionNote: 'Washer replaced',
    });
    expect(out).toMatchObject({
      visitCharge: 300, partsCharge: 700, total: 1000,
      receiptUrl: 'https://x/receipt.pdf', resolutionNote: 'Washer replaced',
    });
    expect(out.totalCharge).toBe(1000); // original columns are kept
  });

  test('unresolved ticket gets nulls, not undefined', () => {
    const out = presentTicketForBuyer({ id: 't2' });
    expect(out).toMatchObject({ visitCharge: null, partsCharge: null, total: null, receiptUrl: null, resolutionNote: null });
  });

  test('passes null through', () => {
    expect(presentTicketForBuyer(null)).toBeNull();
  });
});
