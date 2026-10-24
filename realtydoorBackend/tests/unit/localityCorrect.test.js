jest.mock('../../src/lib/prisma', () => ({
  localitySuggestion: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  localityInsight: { findMany: jest.fn() },
  property: { updateMany: jest.fn() },
  project: { updateMany: jest.fn() },
}));
jest.mock('../../src/lib/cache', () => ({ withCache: jest.fn(), cacheDel: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn() }));
const prisma = require('../../src/lib/prisma');
const svc = require('../../src/modules/locality/locality.service');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.localitySuggestion.findUnique.mockResolvedValue({ id: 's1', city: 'Bengaluru', locality: 'Kabban Park', status: 'PENDING' });
  prisma.localityInsight.findMany.mockResolvedValue([{ locality: 'Cubbon Park' }, { locality: 'Koramangala' }]);
  prisma.localitySuggestion.findMany.mockResolvedValue([{ locality: 'Kabban Park', status: 'PENDING' }]);
  prisma.property.updateMany.mockResolvedValue({ count: 2 });
  prisma.project.updateMany.mockResolvedValue({ count: 1 });
});

test('correcting to a locality we already have merges: listings move, the pending row closes', async () => {
  const r = await svc.correctSuggestion('s1', 'cubbon park', 'admin1');
  expect(r).toMatchObject({ from: 'Kabban Park', to: 'Cubbon Park', merged: true, propertiesUpdated: 2, projectsUpdated: 1 });
  expect(prisma.property.updateMany.mock.calls[0][0].data).toEqual({ locality: 'Cubbon Park' });
  expect(prisma.localitySuggestion.update.mock.calls[0][0].data.status).toBe('RESOLVED');
});

test('correcting to a new spelling renames it and keeps it waiting for details', async () => {
  const r = await svc.correctSuggestion('s1', 'Kubbon Park', 'admin1');
  expect(r).toMatchObject({ to: 'Kubbon Park', merged: false });
  expect(prisma.localitySuggestion.update.mock.calls[0][0].data).toMatchObject({ locality: 'Kubbon Park', key: 'bengaluru|kubbon park' });
});

test('already resolved, missing, same name or blank are refused and nothing is written', async () => {
  prisma.localitySuggestion.findUnique.mockResolvedValueOnce({ id: 's1', city: 'Bengaluru', locality: 'X', status: 'RESOLVED' });
  await expect(svc.correctSuggestion('s1', 'Y Y', 'a')).rejects.toMatchObject({ statusCode: 404 });
  await expect(svc.correctSuggestion('s1', ' ', 'a')).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc.correctSuggestion('s1', 'Kabban Park', 'a')).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.property.updateMany).not.toHaveBeenCalled();
});
