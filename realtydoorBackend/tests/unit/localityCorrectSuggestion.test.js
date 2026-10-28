// Regression for PATCH /locality-insights/suggestions/:id (24 Oct 2026): an admin corrects or merges a partner-added locality.
jest.mock('../../src/lib/prisma', () => ({
  localityInsight: { findMany: jest.fn() },
  localitySuggestion: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  property: { updateMany: jest.fn() },
  project: { updateMany: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/cache', () => ({ withCache: (_k, _t, fn) => fn(), cacheDel: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const locality = require('../../src/modules/locality/locality.service');

const pending = (over = {}) => ({ id: 's1', city: 'Bangalore', locality: 'Kabban Park', status: 'PENDING', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.localityInsight.findMany.mockResolvedValue([{ locality: 'Cubbon Park' }, { locality: 'Whitefield' }]);
  prisma.localitySuggestion.findMany.mockResolvedValue([{ locality: 'Kabban Park', status: 'PENDING' }]);
  prisma.localitySuggestion.findUnique.mockResolvedValue(pending());
  prisma.localitySuggestion.update.mockResolvedValue({});
  prisma.property.updateMany.mockResolvedValue({ count: 3 });
  prisma.project.updateMany.mockResolvedValue({ count: 1 });
});

test('a corrected name that already exists is merged: listings and projects renamed, the pending row closed', async () => {
  const out = await locality.correctSuggestion('s1', '  cubbon   park ', 'a1');
  expect(out).toMatchObject({ from: 'Kabban Park', to: 'Cubbon Park', merged: true, propertiesUpdated: 3, projectsUpdated: 1, correctedBy: 'a1' });
  expect(prisma.property.updateMany.mock.calls[0][0].data).toEqual({ locality: 'Cubbon Park' });
  expect(prisma.project.updateMany.mock.calls[0][0].data).toEqual({ locality: 'Cubbon Park' });
  expect(prisma.localitySuggestion.update.mock.calls[0][0].data).toMatchObject({ status: 'RESOLVED' });
});

test('a corrected name that is new keeps the row pending under the new spelling', async () => {
  const out = await locality.correctSuggestion('s1', 'Kabbon Park', 'a1');
  expect(out).toMatchObject({ to: 'Kabbon Park', merged: false });
  const data = prisma.localitySuggestion.update.mock.calls[0][0].data;
  expect(data.locality).toBe('Kabbon Park');
  expect(data.status).toBeUndefined();
});

test('the listings are found by city (any spelling of it) and the old locality, ignoring letter case', async () => {
  await locality.correctSuggestion('s1', 'Cubbon Park', 'a1');
  const where = prisma.property.updateMany.mock.calls[0][0].where;
  expect(JSON.stringify(where)).toContain('"locality":{"equals":"Kabban Park","mode":"insensitive"}');
});

test('refuses: a row that is not pending, a blank name, and the name it already has', async () => {
  prisma.localitySuggestion.findUnique.mockResolvedValueOnce(pending({ status: 'RESOLVED' }));
  await expect(locality.correctSuggestion('s1', 'Cubbon Park', 'a1')).rejects.toMatchObject({ statusCode: 404 });
  prisma.localitySuggestion.findUnique.mockResolvedValueOnce(null);
  await expect(locality.correctSuggestion('s1', 'Cubbon Park', 'a1')).rejects.toMatchObject({ statusCode: 404 });
  await expect(locality.correctSuggestion('s1', ' x ', 'a1')).rejects.toMatchObject({ statusCode: 400 });
  await expect(locality.correctSuggestion('s1', 'Kabban Park', 'a1')).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.property.updateMany).not.toHaveBeenCalled();
});

test('a change of capital letters only is a real correction and is applied', async () => {
  const out = await locality.correctSuggestion('s1', 'KABBAN PARK', 'a1');
  expect(out).toMatchObject({ to: 'KABBAN PARK', merged: false });
});
