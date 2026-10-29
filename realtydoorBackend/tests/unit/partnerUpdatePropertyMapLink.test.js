jest.mock('../../src/lib/prisma', () => ({
  property: { findUnique: jest.fn(), update: jest.fn() },
  propertyChangeRequest: { updateMany: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(async (ops) => ops),
}));
const prisma = require('../../src/lib/prisma');
const service = require('../../src/modules/properties/properties.service');

test('a partner editing a not-yet-live listing gets map coordinates derived from the new link', async () => {
  prisma.property.findUnique.mockResolvedValue({ id: 'p1', partnerId: 'u1', publishStatus: 'PENDING_APPROVAL', mapLink: null });
  prisma.property.update.mockImplementation(async (a) => ({ id: 'p1', ...a.data }));
  await service.updateProperty('p1', 'u1', { mapLink: 'https://www.google.com/maps/@13.0712,77.7901,17z' });
  const data = prisma.property.update.mock.calls[0][0].data;
  expect(data.mapLinkLatitude).toBeCloseTo(13.0712, 3);
  expect(data.mapLinkLongitude).toBeCloseTo(77.7901, 3);
});

test('a partner cannot edit someone else\'s listing', async () => {
  prisma.property.findUnique.mockResolvedValue({ id: 'p1', partnerId: 'someone-else', publishStatus: 'PENDING_APPROVAL' });
  await expect(service.updateProperty('p1', 'u1', { title: 'Hijacked listing' })).rejects.toMatchObject({ statusCode: 403 });
});

describe('partner photo edits', () => {
  const live = { id: 'p1', partnerId: 'u1', publishStatus: 'PENDING_APPROVAL', images: ['https://s3.example/a.png', 'https://s3.example/b.png', 'https://s3.example/c.png'], videos: ['https://s3.example/v1.mp4'] };

  beforeEach(() => { prisma.property.update.mockReset(); prisma.property.findUnique.mockResolvedValue(live); prisma.property.update.mockImplementation(async (a) => ({ id: 'p1', ...a.data })); });

  test('a partner can reorder and remove their own photos', async () => {
    await service.updateProperty('p1', 'u1', { images: ['https://s3.example/c.png', 'https://s3.example/a.png'], coverImageIndex: 0 });
    expect(prisma.property.update.mock.calls[0][0].data.images).toEqual(['https://s3.example/c.png', 'https://s3.example/a.png']);
  });

  test('a partner cannot add a photo or video link that was not uploaded to the listing', async () => {
    await expect(service.updateProperty('p1', 'u1', { images: ['https://evil.example/x.png'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.updateProperty('p1', 'u1', { videos: ['https://evil.example/v.mp4'] })).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
});
