jest.mock('../../src/lib/prisma', () => ({
  localityInsight: { findMany: jest.fn(), upsert: jest.fn() },
  localitySuggestion: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
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
