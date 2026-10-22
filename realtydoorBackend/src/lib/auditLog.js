const crypto = require('crypto');
const prisma = require('./prisma');

// Audit trail. Append-only: lib/prisma.js refuses update/delete on AuditLog, and
// every row carries an HMAC over its content plus the previous row's hash so a
// silent edit or a removed row is detectable (verifyAuditChain). Callers keep
// the old shape; new optional fields: reason (why), actorRole (ADMIN | PARTNER |
// USER | SYSTEM | WEBHOOK), requestId, metadata. adminId may be null for
// SYSTEM / WEBHOOK actors.

const secret = () => process.env.AUDIT_HMAC_SECRET || process.env.OTP_HASH_SECRET || '';

function canonical(row) {
  return JSON.stringify([
    row.adminId ?? null, row.actorRole ?? null, row.action, row.targetType, row.targetId,
    row.before ?? null, row.after ?? null, row.reason ?? null, row.ipAddress ?? null,
    row.metadata ?? null, row.prevHash ?? null, new Date(row.createdAt).toISOString(),
  ]);
}

function computeHash(row) {
  const key = secret();
  return key
    ? crypto.createHmac('sha256', key).update(canonical(row)).digest('hex')
    : crypto.createHash('sha256').update(canonical(row)).digest('hex');
}

async function createAuditLog({
  adminId, actorRole, action, targetType, targetId, before, after, reason, ipAddress, requestId, metadata,
}) {
  const last = await prisma.auditLog.findFirst({
    orderBy: { createdAt: 'desc' }, select: { hash: true },
  }).catch(() => null);
  const row = {
    adminId: adminId || null,
    actorRole: actorRole || null,
    action, targetType, targetId: String(targetId),
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    reason: reason || null,
    ipAddress: ipAddress || null,
    requestId: requestId || null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    prevHash: last?.hash ?? null,
    createdAt: new Date(),
  };
  row.hash = computeHash(row);
  return prisma.auditLog.create({ data: row });
}

// Re-computes each row's hash from its stored content. Rows written before the
// hash existed (hash null) are counted as unsigned, not as failures. A chain
// link that does not point at the previous row is reported as a break (two
// writes at the same instant can legitimately share a previous row, so breaks
// are for a human to look at, tampering is `tampered`).
async function verifyAuditChain({ limit = 5000 } = {}) {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' }, take: limit });
  let signed = 0; let unsigned = 0; const tampered = []; const breaks = [];
  let prev = null;
  for (const r of rows) {
    if (!r.hash) { unsigned += 1; prev = r; continue; }
    signed += 1;
    if (computeHash(r) !== r.hash) tampered.push(r.id);
    if (prev && prev.hash && r.prevHash !== prev.hash) breaks.push(r.id);
    prev = r;
  }
  return { checked: rows.length, signed, unsigned, tampered, breaks, ok: tampered.length === 0 };
}

module.exports = { createAuditLog, verifyAuditChain, computeHash };
