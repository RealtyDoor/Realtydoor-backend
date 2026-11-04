const { isPartnerBrought, isCampaignLead, rotationOrder } = require('../../src/lib/leadAssignRules');

describe('isPartnerBrought (what automatic assignment must leave alone)', () => {
  test('a lead a partner added is theirs', () => {
    expect(isPartnerBrought({ addedByPartnerId: 'p1', source: 'PARTNER' })).toBe(true);
    expect(isPartnerBrought({ addedByPartnerId: 'p1', source: 'WEBSITE' })).toBe(true);
  });
  test('a lead marked as coming from a partner is theirs even if the adder is missing', () => {
    expect(isPartnerBrought({ source: 'PARTNER' })).toBe(true);
  });
  test('the company\'s own leads are not partner-brought', () => {
    for (const source of ['WEBSITE', 'PHONE', 'WALK_IN', 'REFERRAL', 'EMAIL', 'OTHER']) expect(isPartnerBrought({ source, addedByPartnerId: null })).toBe(false);
  });
  test('nothing at all is not partner-brought', () => {
    expect(isPartnerBrought(null)).toBe(false);
    expect(isPartnerBrought(undefined)).toBe(false);
    expect(isPartnerBrought({})).toBe(false);
  });
});

describe('isCampaignLead (the only leads assigned automatically)', () => {
  test('a lead with a campaign name is one', () => {
    expect(isCampaignLead({ campaign: 'Diwali 2026' })).toBe(true);
  });
  test('a lead with no campaign, a blank one or a non-text one is not', () => {
    for (const campaign of [undefined, null, '', '   ', 5]) expect(isCampaignLead({ campaign })).toBe(false);
    expect(isCampaignLead(null)).toBe(false);
    expect(isCampaignLead({})).toBe(false);
  });
});

describe('rotationOrder (round robin)', () => {
  const people = ['a', 'b', 'c'].map((id) => ({ id }));
  const at = (d) => new Date(2026, 10, d).toISOString();
  test('someone who never had a campaign lead goes first, then the one who waited longest', () => {
    expect(rotationOrder(people, { a: at(3), c: at(1) }).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });
  test('after a lead is given, that partner moves to the back', () => {
    const before = rotationOrder(people, { a: at(1), b: at(2), c: at(3) }).map((p) => p.id);
    expect(before[0]).toBe('a');
    const after = rotationOrder(people, { a: at(4), b: at(2), c: at(3) }).map((p) => p.id);
    expect(after).toEqual(['b', 'c', 'a']);
  });
  test('with nobody having had one, the order is steady (by id), run after run', () => {
    expect(rotationOrder([{ id: 'c' }, { id: 'a' }, { id: 'b' }]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(rotationOrder([{ id: 'b' }, { id: 'c' }, { id: 'a' }]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
  test('does not change the list it is given, and copes with no candidates', () => {
    const input = [{ id: 'b' }, { id: 'a' }];
    rotationOrder(input);
    expect(input.map((p) => p.id)).toEqual(['b', 'a']);
    expect(rotationOrder([])).toEqual([]);
  });
});
