const { presentTicketForBuyer } = require('../../src/lib/ticketPresenter');

describe('presentTicketForBuyer', () => {
  test('adds buyer-facing names for the charge breakdown, receipt and resolution note', () => {
    const out = presentTicketForBuyer({
      id: 't1', visitCharge: 300, partsCharge: 700, totalCharge: 1000,
      invoiceUrl: 'https://x/receipt.pdf', resolutionNote: 'Washer replaced',
    });
    expect(out).toMatchObject({
      partsCharge: 700, total: 700,
      receiptUrl: 'https://x/receipt.pdf', resolutionNote: 'Washer replaced',
    });
  });

  test('unresolved ticket gets nulls, not undefined', () => {
    const out = presentTicketForBuyer({ id: 't2' });
    expect(out).toMatchObject({ partsCharge: null, total: null, receiptUrl: null, resolutionNote: null });
  });

  test('passes null through', () => {
    expect(presentTicketForBuyer(null)).toBeNull();
  });

  test('the buyer never gets the visit charge, or a total that includes it (T12)', () => {
    const out = presentTicketForBuyer({ id: 't3', visitCharge: 500, partsCharge: 0, totalCharge: 500 });
    expect(out).not.toHaveProperty('visitCharge');
    expect(out).not.toHaveProperty('totalCharge');
    expect(out.total).toBeNull();
    expect(JSON.stringify(out)).not.toContain('500');
  });
});
