jest.mock('../../src/lib/prisma', () => ({
  localityInsight: { findMany: jest.fn(), upsert: jest.fn() },
  localitySuggestion: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({ count: 1 }) }));
jest.mock('../../src/lib/cache', () => ({ withCache: (_k, _t, fn) => fn(), cacheDel: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const locality = require('../../src/modules/locality/locality.service');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.localityInsight.findMany.mockResolvedValue([{ locality: 'Whitefield' }, { locality: 'Indiranagar' }]);
  prisma.localitySuggestion.findMany.mockResolvedValue([]);
  prisma.localitySuggestion.create.mockResolvedValue({});
  prisma.localitySuggestion.updateMany.mockResolvedValue({ count: 1 });
  prisma.localitySuggestion.count.mockResolvedValue(0);
});

describe('locality dropdown options', () => {
  test('curated localities come back A to Z, once each', async () => {
    prisma.localitySuggestion.findMany.mockResolvedValue([{ locality: 'whitefield', status: 'PENDING' }, { locality: 'Hebbal', status: 'PENDING' }]);
    const out = await locality.listLocalityOptions('Bangalore');
    expect(out).toEqual([
      { name: 'Hebbal', pending: true },
      { name: 'Indiranagar', pending: false },
      { name: 'Whitefield', pending: false },
    ]);
  });
  test('a city is required', async () => {
    await expect(locality.listLocalityOptions('')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('adding a locality that is not in the list', () => {
  const partner = { id: '64b000000000000000000001', role: 'PARTNER' };

  test('a new name is saved, usable at once, and the admins are told to fill in the CMS', async () => {
    const out = await locality.suggestLocality({ city: 'Bangalore', locality: '  Kogilu   Cross ' }, partner);
    expect(out).toEqual({ city: expect.any(String), locality: 'Kogilu Cross', created: true });
    expect(prisma.localitySuggestion.create.mock.calls[0][0].data).toMatchObject({ locality: 'Kogilu Cross', addedByUserId: partner.id });
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    const n = notifyAdmins.mock.calls[0][0];
    expect(n.message).toContain('Kogilu Cross');
    expect(n.message).toContain('CMS');
    expect(n.linkUrl).toContain('/admin/cms/locality-insights/new');
  });

  test('a name already in the list (any letter case) is returned as it is, with no second alert', async () => {
    const out = await locality.suggestLocality({ city: 'Bangalore', locality: 'WHITEFIELD' }, partner);
    expect(out).toMatchObject({ locality: 'Whitefield', created: false });
    expect(prisma.localitySuggestion.create).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  test('a name a partner already added is not alerted twice', async () => {
    prisma.localitySuggestion.findMany.mockResolvedValue([{ locality: 'Hebbal', status: 'PENDING' }]);
    const out = await locality.suggestLocality({ city: 'Bangalore', locality: 'hebbal' }, partner);
    expect(out.created).toBe(false);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  test('when the admin saves the full locality, the suggestion is marked resolved', async () => {
    prisma.localityInsight.upsert.mockResolvedValue({ locality: 'Hebbal' });
    await locality.upsertLocality({ city: 'Bangalore', locality: 'Hebbal', avgPricePerSqftPaise: 700000 }, 'admin1');
    expect(prisma.localitySuggestion.updateMany.mock.calls[0][0]).toMatchObject({ data: { status: 'RESOLVED' } });
  });
});

describe('abuse and edge cases for adding a locality', () => {
  const partner = { id: '64b000000000000000000001', role: 'PARTNER' };

  test('one account cannot add more than 10 new localities a day', async () => {
    prisma.localitySuggestion.count.mockResolvedValue(10);
    await expect(locality.suggestLocality({ city: 'Bangalore', locality: 'Brand New Place' }, partner))
      .rejects.toMatchObject({ statusCode: 429, data: { code: 'LOCALITY_DAILY_LIMIT' } });
    expect(prisma.localitySuggestion.create).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  test('losing the race to add the same new name is not an error and sends no second alert', async () => {
    prisma.localitySuggestion.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const out = await locality.suggestLocality({ city: 'Bangalore', locality: 'Brand New Place' }, partner);
    expect(out.created).toBe(false);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  test('any other database error is not swallowed', async () => {
    prisma.localitySuggestion.create.mockRejectedValue(new Error('db down'));
    await expect(locality.suggestLocality({ city: 'Bangalore', locality: 'Brand New Place' }, partner)).rejects.toThrow('db down');
  });
});

describe('locality input validation', () => {
  const { suggestLocalitySchema, localityOptionsQuerySchema } = require('../../src/modules/locality/locality.validator');

  test.each(['Kogilu Cross', 'Yelahanka (New Town)', "St. Mark's Road", 'HSR Layout 2nd Sector', 'Koramangala 5th Block', 'ಯಲಹಂಕ', 'बेंगलुरु', 'J.P. Nagar', 'R&D Colony', 'A-B/C'])(
    'accepts the real place name %s',
    (name) => { expect(suggestLocalitySchema.parse({ city: 'Bangalore', locality: name }).locality).toBe(name); },
  );

  test.each(['<script>alert(1)</script>', 'Whitefield<img src=x>', '"; drop', 'a', ' ', '', '{"$ne":null}', 'line\nbreak', 'x'.repeat(81), '=cmd|calc', '-leading', '/leading'])(
    'rejects %j',
    (bad) => { expect(() => suggestLocalitySchema.parse({ city: 'Bangalore', locality: bad })).toThrow(); },
  );

  test('trims spaces, rejects a non-string, and the options query needs a real city', () => {
    expect(suggestLocalitySchema.parse({ city: ' Bangalore ', locality: '  Hebbal ' })).toEqual({ city: 'Bangalore', locality: 'Hebbal' });
    expect(() => suggestLocalitySchema.parse({ city: 'Bangalore', locality: { $ne: 'x' } })).toThrow();
    expect(() => suggestLocalitySchema.parse({ city: ['a', 'b'], locality: 'Hebbal' })).toThrow();
    expect(() => localityOptionsQuerySchema.parse({ city: undefined })).toThrow();
    expect(() => localityOptionsQuerySchema.parse({ city: '<b>x</b>' })).toThrow();
  });
});
