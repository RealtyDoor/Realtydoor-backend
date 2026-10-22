const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { isMoneyKey } = require('../money/moneyConfig');
const { createAuditLog } = require('../../lib/auditLog');

// Keys the frontend depends on unconditionally (no code-level fallback of its
// own, unlike e.g. max_active_inquiries/max_inquiries_per_day which always
// read through getConfigNumber(key, fallback) below). An environment seeded
// before a key like this existed won't have the PlatformConfig row until an
// admin adds one or someone runs the seed's upsert — until then, this fills
// the gap. Any real row in the DB always wins; this only covers an absence.
const PUBLIC_CONFIG_DEFAULTS = {
  telecaller_phone: '+919844412345',
};

async function getPublicConfig() {
  return withCache(CACHE_KEYS.PUBLIC_CONFIG, 1800, async () => {
    const entries = await prisma.platformConfig.findMany({
      where: { isPublic: true },
      select: { key: true, value: true },
    });
    return { ...PUBLIC_CONFIG_DEFAULTS, ...Object.fromEntries(entries.map((e) => [e.key, e.value])) };
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

// B28 — a webhook secret was sitting in PlatformConfig as plain text and shown
// in the admin list. Nothing reads it from here (RAZORPAY_WEBHOOK_SECRET comes
// from the environment), so secrets are masked on read and refused on write.
const SECRET_KEY = /(secret|password|api_key|private_key|access_token|auth_token)$/;
const isSecretKey = (key) => SECRET_KEY.test(key);

async function adminListConfig() {
  const rows = await prisma.platformConfig.findMany({ orderBy: { key: 'asc' } });
  return rows.map((r) => (isSecretKey(r.key) ? { ...r, value: '********' } : r));
}

// B102 — readers like getConfigNumber() silently fall back to their default
// when a stored value isn't a number, so saving "abc" for a numeric key would
// look like it worked while the platform kept using the fallback. Reject it at
// write time instead. A key counts as numeric by its name, or because the row
// already holds a number; likewise boolean for rows already holding true/false.
// Phone numbers and similar text happen to parse as numbers; never treat them as numeric by value.
const TEXT_KEY = /phone|email|name|secret|disclaimer|url/;
const NUMERIC_KEY = /(_pct|_days|_hours|_minutes|_rupees|_amount)$|^(max|min)_/;

function validateConfigValue(key, value, existing) {
  const current = existing?.value;
  const looksNumeric = NUMERIC_KEY.test(key) || (!TEXT_KEY.test(key) && current != null && current.trim() !== '' && Number.isFinite(Number(current)));
  const looksBoolean = current === 'true' || current === 'false';
  if (looksBoolean && value !== 'true' && value !== 'false') {
    throw new ApiError(400, `"${key}" must be "true" or "false"`);
  }
  if (looksNumeric && !looksBoolean) {
    const num = Number(value);
    if (value.trim() === '' || !Number.isFinite(num) || num < 0) {
      throw new ApiError(400, `"${key}" must be a non-negative number`);
    }
    if (key.endsWith('_pct') && num > 100) {
      throw new ApiError(400, `"${key}" is a percentage and cannot exceed 100`);
    }
  }
}

async function adminUpsertConfig(key, { value, description, isPublic, reason }, adminId, ip) {
  if (isSecretKey(key)) {
    throw new ApiError(400, `"${key}" looks like a secret. Store secrets in the server environment, not in platform config.`, { code: 'CONFIG_SECRET_REFUSED' });
  }
  const existing = await prisma.platformConfig.findUnique({ where: { key } });
  validateConfigValue(key, value, existing);
  // Money model phase 2: a rate, fee, TDS or refund setting changes only with a
  // reason, and the old and new value are kept in the audit trail.
  const money = isMoneyKey(key);
  if (money && !reason?.trim()) {
    throw new ApiError(400, `Changing "${key}" needs a reason (it is a money setting and is audited).`, { code: 'REASON_REQUIRED' });
  }
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
  if (money) {
    await createAuditLog({
      adminId, actorRole: 'ADMIN', action: 'MONEY_SETTING_CHANGED', targetType: 'PlatformConfig', targetId: key,
      before: existing ? { value: existing.value } : null, after: { value }, reason: reason.trim(), ipAddress: ip,
    });
  }
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
