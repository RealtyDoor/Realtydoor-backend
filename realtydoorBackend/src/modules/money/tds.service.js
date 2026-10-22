'use strict';

// TDS ledger (money model Rev 3, phase 2): per partner and quarter, what was
// withheld, whether it is deposited, and the return / certificate trail. The
// rows are written at payout (escrow.service); here the accountant records the
// deposit (challan, BSR), the Form 26Q quarter and the Form 16A date. Only
// those fields can change (lib/immutability.js). Every action is audited.

const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const ledger = require('./ledger.service');

const maskPan = (pan) => (pan ? `${'X'.repeat(Math.max(0, pan.length - 4))}${pan.slice(-4)}` : null);

function statusOf(t, now = new Date()) {
  if (t.tdsPaise === 0) return 'NO_TDS';
  if (t.depositedAt) return 'DEPOSITED';
  return t.depositDueDate && new Date(t.depositDueDate) < now ? 'OVERDUE' : 'PENDING_DEPOSIT';
}

const present = (t, now) => ({ ...t, panAtDeduction: maskPan(t.panAtDeduction), status: statusOf(t, now) });

function whereFrom(f = {}) {
  const where = {};
  if (f.partnerId) where.partnerId = f.partnerId;
  if (f.financialYear) where.financialYear = f.financialYear;
  if (f.quarter) where.quarter = Number(f.quarter);
  if (f.status === 'DEPOSITED') where.depositedAt = { isSet: true };
  if (f.status === 'PENDING_DEPOSIT' || f.status === 'OVERDUE') {
    where.depositedAt = { isSet: false };
    where.tdsPaise = { gt: 0 };
    if (f.status === 'OVERDUE') where.depositDueDate = { lt: new Date() };
  }
  return where;
}

async function list(filters, skip, limit) {
  const where = whereFrom(filters);
  const now = new Date();
  const [rows, total, redList] = await Promise.all([
    prisma.tdsEntry.findMany({ where, skip, take: limit, orderBy: { deductedAt: 'desc' } }),
    prisma.tdsEntry.count({ where }),
    prisma.tdsEntry.count({ where: { depositedAt: { isSet: false }, tdsPaise: { gt: 0 }, depositDueDate: { lt: now } } }),
  ]);
  const partnerIds = [...new Set(rows.map((r) => r.partnerId))];
  const partners = partnerIds.length ? await prisma.user.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true, companyName: true } }) : [];
  const byId = new Map(partners.map((p) => [p.id, p]));
  return { data: rows.map((r) => ({ ...present(r, now), partner: byId.get(r.partnerId) || null })), total, overdueCount: redList };
}

// Per partner per financial-year quarter: the figures for Form 26Q and 16A.
async function summary(filters) {
  const rows = await prisma.tdsEntry.findMany({ where: whereFrom({ ...filters, status: undefined }) });
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.partnerId}|${r.financialYear}|${r.quarter}`;
    const g = groups.get(key) || {
      partnerId: r.partnerId, financialYear: r.financialYear, quarter: r.quarter, pan: maskPan(r.panAtDeduction),
      commissionPaise: 0, tdsPaise: 0, depositedPaise: 0, entries: 0, returnFiled: true, form16aIssued: true,
    };
    g.commissionPaise += r.commissionBasePaise; g.tdsPaise += r.tdsPaise; g.entries += 1;
    if (r.depositedAt) g.depositedPaise += r.tdsPaise;
    if (r.tdsPaise > 0 && !r.returnFiledAt) g.returnFiled = false;
    if (r.tdsPaise > 0 && !r.form16aIssuedAt) g.form16aIssued = false;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, outstandingPaise: g.tdsPaise - g.depositedPaise }));
}

async function recordDeposit(ids, { challanNumber, bsrCode, depositedAt }, adminId, ip) {
  if (!challanNumber?.trim() || !bsrCode?.trim()) throw new ApiError(400, 'Challan number and BSR code are required');
  const when = depositedAt ? new Date(depositedAt) : new Date();
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 24 * 3600e3) throw new ApiError(400, 'depositedAt is not a valid past date');
  const done = [];
  for (const id of ids) {
    const t = await prisma.tdsEntry.findUnique({ where: { id } });
    if (!t) throw new ApiError(404, `TDS entry ${id} not found`);
    if (t.depositedAt) throw new ApiError(409, `TDS entry ${id} is already deposited`, { code: 'ALREADY_DEPOSITED' });
    if (t.tdsPaise === 0) throw new ApiError(400, `TDS entry ${id} has no TDS to deposit`);
    const updated = await prisma.tdsEntry.update({ where: { id }, data: { depositedAt: when, challanNumber: challanNumber.trim(), bsrCode: bsrCode.trim() } });
    await ledger.onTdsDeposited(updated, { adminId });
    await createAuditLog({
      adminId, actorRole: 'ADMIN', action: 'TDS_DEPOSITED', targetType: 'TdsEntry', targetId: id,
      before: { depositedAt: null }, after: { depositedAt: when, challanNumber: challanNumber.trim(), bsrCode: bsrCode.trim(), tdsPaise: t.tdsPaise }, ipAddress: ip,
    });
    done.push(updated);
  }
  return done.map((t) => present(t));
}

async function recordReturn(ids, { returnQuarter, filedAt }, adminId, ip) {
  if (!returnQuarter?.trim()) throw new ApiError(400, 'returnQuarter is required (for example "2026-27 Q3")');
  const when = filedAt ? new Date(filedAt) : new Date();
  const done = [];
  for (const id of ids) {
    const t = await prisma.tdsEntry.findUnique({ where: { id } });
    if (!t) throw new ApiError(404, `TDS entry ${id} not found`);
    if (t.tdsPaise > 0 && !t.depositedAt) throw new ApiError(409, `TDS entry ${id} is not deposited yet; a return reports deposited TDS`, { code: 'NOT_DEPOSITED' });
    const updated = await prisma.tdsEntry.update({ where: { id }, data: { returnQuarter: returnQuarter.trim(), returnFiledAt: when } });
    await createAuditLog({
      adminId, actorRole: 'ADMIN', action: 'TDS_RETURN_RECORDED', targetType: 'TdsEntry', targetId: id,
      before: { returnQuarter: t.returnQuarter ?? null }, after: { returnQuarter: returnQuarter.trim(), returnFiledAt: when }, ipAddress: ip,
    });
    done.push(updated);
  }
  return done.map((t) => present(t));
}

async function recordForm16a(ids, { issuedAt }, adminId, ip) {
  const when = issuedAt ? new Date(issuedAt) : new Date();
  const done = [];
  for (const id of ids) {
    const t = await prisma.tdsEntry.findUnique({ where: { id } });
    if (!t) throw new ApiError(404, `TDS entry ${id} not found`);
    if (t.tdsPaise > 0 && !t.returnFiledAt) throw new ApiError(409, `TDS entry ${id}: file the return before issuing Form 16A`, { code: 'RETURN_NOT_FILED' });
    const updated = await prisma.tdsEntry.update({ where: { id }, data: { form16aIssuedAt: when } });
    await createAuditLog({
      adminId, actorRole: 'ADMIN', action: 'TDS_FORM16A_ISSUED', targetType: 'TdsEntry', targetId: id,
      after: { form16aIssuedAt: when }, ipAddress: ip,
    });
    done.push(updated);
  }
  return done.map((t) => present(t));
}

module.exports = { list, summary, recordDeposit, recordReturn, recordForm16a, statusOf, maskPan, whereFrom };
