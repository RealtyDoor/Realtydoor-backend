const { canLinkLeadToUser } = require('../../src/lib/leadClaim');

const user = { id: 'u1', role: 'USER', phone: '+919999999999', phoneVerified: true };
const lead = { id: 'l1', buyerId: null, buyerPhone: '+919999999999', status: 'ASSIGNED' };

describe('canLinkLeadToUser (B21)', () => {
  test('verified buyer with the same phone can be linked', () => {
    expect(canLinkLeadToUser(lead, user)).toBe(true);
    expect(canLinkLeadToUser({ ...lead, buyerId: undefined }, user)).toBe(true);
  });
  test('never re-links a lead that already has a buyer', () => {
    expect(canLinkLeadToUser({ ...lead, buyerId: 'someone' }, user)).toBe(false);
  });
  test('phone must match and be verified', () => {
    expect(canLinkLeadToUser({ ...lead, buyerPhone: '+918888888888' }, user)).toBe(false);
    expect(canLinkLeadToUser(lead, { ...user, phoneVerified: false })).toBe(false);
    expect(canLinkLeadToUser(lead, { ...user, phone: null })).toBe(false);
  });
  test('only real, active buyer accounts', () => {
    expect(canLinkLeadToUser(lead, { ...user, role: 'PARTNER' })).toBe(false);
    expect(canLinkLeadToUser(lead, { ...user, deletedAt: new Date() })).toBe(false);
    expect(canLinkLeadToUser(lead, { ...user, isSuspended: true })).toBe(false);
  });
  test('not before admin has reviewed, not once dropped', () => {
    expect(canLinkLeadToUser({ ...lead, status: 'AWAITING_ADMIN' }, user)).toBe(false);
    expect(canLinkLeadToUser({ ...lead, status: 'DROPPED' }, user)).toBe(false);
  });
});
