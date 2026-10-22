const { ticketVendorDispatchedTemplate } = require('../../src/lib/wati');

describe('ticketVendorDispatchedTemplate (T13)', () => {
  test('keeps the approved v1 until v2 is listed as live', () => {
    expect(ticketVendorDispatchedTemplate({})).toBe('ticket_vendor_dispatched');
    expect(ticketVendorDispatchedTemplate({ WATI_LIVE_TEMPLATES: 'escrow_token_received' })).toBe('ticket_vendor_dispatched');
  });
  test('switches to v2 the moment it is listed (spaces ignored)', () => {
    expect(ticketVendorDispatchedTemplate({ WATI_LIVE_TEMPLATES: 'escrow_token_received, ticket_vendor_dispatched_v2' })).toBe('ticket_vendor_dispatched_v2');
  });
});
