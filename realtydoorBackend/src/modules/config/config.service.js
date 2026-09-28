const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

async function getPublicConfig() {
  return withCache(CACHE_KEYS.PUBLIC_CONFIG, 1800, async () => {
    const entries = await prisma.platformConfig.findMany({
      where: { isPublic: true },
      select: { key: true, value: true },
    });
    return Object.fromEntries(entries.map((e) => [e.key, e.value]));
  });
}

// ─── Typed readers for other modules to consume config at decision time ──────
// Deliberately uncached — callers depend on an admin's edit taking effect on
// the very next read, not after a TTL (see FRONTEND_HANDOFF_SPEC.md §9.1).

async function getConfigValue(key, fallback = null) {
  const entry = await prisma.platformConfig.findUnique({ where: { key } });
  return entry ? entry.value : fallback;
}

async function getConfigNumber(key, fallback) {
  const entry = await prisma.platformConfig.findUnique({ where: { key } });
  const num = entry ? Number(entry.value) : NaN;
  return Number.isFinite(num) ? num : fallback;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

async function adminListConfig() {
  return prisma.platformConfig.findMany({ orderBy: { key: 'asc' } });
}

async function adminUpsertConfig(key, { value, description, isPublic }, adminId) {
  const updated = await prisma.platformConfig.upsert({
    where:  { key },
    create: { key, value, description, isPublic: isPublic ?? false, updatedByAdminId: adminId },
    update: {
      value,
      ...(description !== undefined && { description }),
      ...(isPublic    !== undefined && { isPublic }),
      updatedByAdminId: adminId,
    },
  });
  cacheDel(CACHE_KEYS.PUBLIC_CONFIG);
  return updated;
}

async function adminDeleteConfig(key) {
  const entry = await prisma.platformConfig.findUnique({ where: { key } });
  if (!entry) throw new ApiError(404, `Config key "${key}" not found`);
  const deleted = await prisma.platformConfig.delete({ where: { key } });
  cacheDel(CACHE_KEYS.PUBLIC_CONFIG);
  return deleted;
}

module.exports = {
  getPublicConfig, adminListConfig, adminUpsertConfig, adminDeleteConfig,
  getConfigValue, getConfigNumber,
};
