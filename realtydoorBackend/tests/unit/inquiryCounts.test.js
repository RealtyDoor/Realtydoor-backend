const { countInquiriesByUser } = require('../../src/lib/inquiryCounts');

const users = [{ id: 'u1', phone: '+911' }, { id: 'u2', phone: '+912' }, { id: 'u3', phone: null }];

describe('countInquiriesByUser', () => {
  test('counts account-linked leads', () => {
    const c = countInquiriesByUser(users, [{ buyerId: 'u1', buyerPhone: '+911' }, { buyerId: 'u1', buyerPhone: '+999' }]);
    expect(c.get('u1')).toBe(2);
  });
  test('counts unlinked leads by phone (partner-added)', () => {
    const c = countInquiriesByUser(users, [{ buyerId: null, buyerPhone: '+912' }, { buyerPhone: '+912' }]);
    expect(c.get('u2')).toBe(2);
  });
  test('never claims by phone a lead linked to another account', () => {
    const c = countInquiriesByUser(users, [{ buyerId: 'other', buyerPhone: '+911' }]);
    expect(c.get('u1')).toBe(0);
  });
  test('users without a phone only match by account', () => {
    const c = countInquiriesByUser(users, [{ buyerId: null, buyerPhone: null }, { buyerId: 'u3' }]);
    expect(c.get('u3')).toBe(1);
  });
});

describe('inquiryWhereForUser (T42)', () => {
  const { inquiryWhereForUser } = require('../../src/lib/inquiryCounts');
  test('matches by account, and by phone only for leads with no account', () => {
    expect(inquiryWhereForUser({ id: 'u1', phone: '+919999999999' })).toEqual({
      OR: [{ buyerId: 'u1' }, { buyerId: null, buyerPhone: '+919999999999' }],
    });
  });
  test('a user with no phone matches by account only', () => {
    expect(inquiryWhereForUser({ id: 'u1', phone: null })).toEqual({ OR: [{ buyerId: 'u1' }] });
  });
});
