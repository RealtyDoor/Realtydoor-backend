jest.mock('../../src/lib/prisma', () => ({
  auditLog: { findFirst: jest.fn() },
  microsite: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/cache', () => ({ withCache: (k, t, fn) => fn(), cacheDel: jest.fn() }));
jest.mock('../../src/modules/properties/properties.service', () => ({ getPropertyByIdOrSlug: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { findCurrentSlugForOldSlug, getBySlug } = require('../../src/modules/microsites/microsite.service');

beforeEach(() => jest.clearAllMocks());

describe('old microsite slug (T38)', () => {
  it('returns the current slug of the renamed microsite', async () => {
    prisma.auditLog.findFirst.mockResolvedValue({ targetId: 'm1' });
    prisma.microsite.findUnique.mockResolvedValue({ slug: 'new-slug', enabled: true });
    await expect(findCurrentSlugForOldSlug('old-slug')).resolves.toBe('new-slug');
    expect(prisma.auditLog.findFirst.mock.calls[0][0].where.before.contains).toBe('"slug":"old-slug"');
  });
  it('null when never renamed, removed or disabled', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);
    await expect(findCurrentSlugForOldSlug('nope')).resolves.toBeNull();
    prisma.auditLog.findFirst.mockResolvedValue({ targetId: 'm1' });
    prisma.microsite.findUnique.mockResolvedValue(null);
    await expect(findCurrentSlugForOldSlug('gone')).resolves.toBeNull();
    prisma.microsite.findUnique.mockResolvedValue({ slug: 'x', enabled: false });
    await expect(findCurrentSlugForOldSlug('off')).resolves.toBeNull();
  });
  it('refuses a slug that is not a plain slug (no query injection)', async () => {
    await expect(findCurrentSlugForOldSlug('a","enabled')).resolves.toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });
  it('getBySlug answers redirectTo for an old slug and 404 otherwise', async () => {
    prisma.microsite.findUnique.mockResolvedValueOnce(null).mockResolvedValue({ slug: 'new-slug', enabled: true });
    prisma.auditLog.findFirst.mockResolvedValue({ targetId: 'm1' });
    await expect(getBySlug('old-slug')).resolves.toEqual({ redirectTo: 'new-slug' });
    prisma.microsite.findUnique.mockReset().mockResolvedValue(null);
    prisma.auditLog.findFirst.mockResolvedValue(null);
    await expect(getBySlug('zzz')).rejects.toMatchObject({ statusCode: 404 });
  });
});
