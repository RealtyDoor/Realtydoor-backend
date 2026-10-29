jest.mock('../../src/lib/prisma', () => {
  const tx = [];
  return {
    property: { findUnique: jest.fn(), update: jest.fn() },
    propertyEditLog: { create: jest.fn((a) => ({ __log: a.data })) },
    $transaction: jest.fn(async (ops) => ops),
    __tx: tx,
  };
});
jest.mock('../../src/lib/notifications', () => ({ ...jest.requireActual('../../src/lib/notifications'), createNotification: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/cache', () => ({ ...jest.requireActual('../../src/lib/cache'), cacheDel: jest.fn(), cacheDelPattern: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const service = require('../../src/modules/admin/admin.service');

const base = {
  id: 'p1', partnerId: 'u1', title: 'Plot', publishStatus: 'APPROVED', city: 'Bengaluru', locality: 'Hoskote-Bagalur Road',
  amenities: ['Park', 'Gym'], possessionDate: new Date('2026-12-01T00:00:00.000Z'), isVerified: false, verifiedAt: null, price: 100,
};

async function edit(data) {
  prisma.property.findUnique.mockResolvedValue(base);
  prisma.property.update.mockImplementation(async (a) => ({ ...base, ...a.data }));
  prisma.propertyEditLog.create.mockClear();
  const updated = await service.editProperty('p1', data, 'admin1', 'Admin', '1.1.1.1');
  const logged = prisma.propertyEditLog.create.mock.calls.map((c) => c[0].data.fieldChanged);
  return { updated, logged, updateArg: prisma.property.update.mock.calls.at(-1)[0] };
}

describe('admin editProperty', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not log an unchanged list or date as a change', async () => {
    const { logged } = await edit({ amenities: ['Park', 'Gym'], possessionDate: '2026-12-01T00:00:00.000Z', price: 100 });
    expect(logged).toEqual([]);
  });

  it('logs a changed list, a changed date and a cleared field', async () => {
    const { logged } = await edit({ amenities: ['Park'], possessionDate: '2027-01-01T00:00:00.000Z', price: null });
    expect(logged.sort()).toEqual(['amenities', 'possessionDate', 'price']);
  });

  it('writes the locality the admin chose', async () => {
    const { updateArg, logged } = await edit({ locality: 'Hoskote' });
    expect(updateArg.data.locality).toBe('Hoskote');
    expect(logged).toEqual(['locality']);
  });

  it('stores the canonical city spelling', async () => {
    const { updateArg } = await edit({ city: 'Bangalore' });
    expect(updateArg.data.city).toBe('Bengaluru');
  });

  it('stamps verifiedAt when a listing becomes verified, and clears it when it stops being verified', async () => {
    const on = await edit({ isVerified: true });
    expect(on.updateArg.data.verifiedAt).toBeInstanceOf(Date);
    prisma.property.findUnique.mockResolvedValue({ ...base, isVerified: true, verifiedAt: new Date() });
    prisma.property.update.mockImplementation(async (a) => ({ ...base, ...a.data }));
    await service.editProperty('p1', { isVerified: false }, 'admin1', 'Admin', '1.1.1.1');
    expect(prisma.property.update.mock.calls.at(-1)[0].data.verifiedAt).toBeNull();
  });

  it('derives the coordinates from a changed map link, and clears them when the link is cleared', async () => {
    const link = 'https://www.google.com/maps/@13.0712,77.7901,17z';
    const set = await edit({ mapLink: link });
    expect(set.updateArg.data.mapLinkLatitude).toBeCloseTo(13.0712, 3);
    expect(set.updateArg.data.mapLinkLongitude).toBeCloseTo(77.7901, 3);
    const cleared = await edit({ mapLink: null });
    expect(cleared.updateArg.data.mapLinkLatitude).toBeNull();
    expect(cleared.updateArg.data.mapLinkLongitude).toBeNull();
  });
});
