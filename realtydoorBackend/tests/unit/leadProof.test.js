// A partner registers a buyer. Within 72 hours the buyer must show a sign of life, or the registration lapses and the buyer is free.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { getConfigNumber } = require('../../src/modules/config/config.service');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const t = require('../../src/lib/leadTimers');
const { decideBuyerOwnership } = require('../../src/lib/leadOwnership');
const job = require('../../src/jobs/leadHygiene');

const NOW = new Date('2026-11-04T10:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3_600_000);
const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', buyerName: 'Meena', buyerPhone: '+919000000001', status: 'ASSIGNED', addedByPartnerId: 'A', assignedPartnerId: 'A', assignedAt: ago(10), createdAt: ago(12), escrowTransactions: [], ...over });

describe('proofAction', () => {
  test('nothing happens inside the first two thirds of the window', () => {
    expect(t.proofAction(lead({ assignedAt: ago(40) }), NOW, 72)).toBe('none');
  });
  test('a warning once, at two thirds (48 of 72 hours)', () => {
    expect(t.proofAction(lead({ assignedAt: ago(49) }), NOW, 72)).toBe('warn');
    expect(t.proofAction(lead({ assignedAt: ago(49), proofWarnedAt: ago(1) }), NOW, 72)).toBe('none');
  });
  test('lapses at 72 hours with no sign of life', () => {
    expect(t.proofAction(lead({ assignedAt: ago(72) }), NOW, 72)).toBe('lapse');
    expect(t.proofAction(lead({ assignedAt: ago(200) }), NOW, 72)).toBe('lapse');
    expect(t.proofAction(lead({ assignedAt: ago(71) }), NOW, 72)).toBe('warn');
  });
  test('a visit booked, an OTP verified, money held, or a buyer who signed up are each a sign of life', () => {
    const old = { assignedAt: ago(100) };
    expect(t.proofAction(lead({ ...old, siteVisitScheduledAt: ago(5) }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ ...old, isOtpVerified: true }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ ...old, escrowTransactions: [{ status: 'HELD' }] }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead(old), NOW, 72, true)).toBe('none');
  });
  test('a failed or pending payment is not a sign of life', () => {
    expect(t.proofAction(lead({ assignedAt: ago(100), escrowTransactions: [{ status: 'FAILED' }, { status: 'PAYMENT_PENDING' }] }), NOW, 72)).toBe('lapse');
  });
  test('the clock starts when admin confirmed the lead, not when it was added; a lead waiting for admin is not timed', () => {
    expect(t.proofAction(lead({ createdAt: ago(100), assignedAt: ago(10) }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ createdAt: ago(100), assignedAt: null }), NOW, 72)).toBe('lapse');
    expect(t.proofAction(lead({ status: 'AWAITING_ADMIN', createdAt: ago(500), assignedAt: null }), NOW, 72)).toBe('none');
  });
  test('only a lead a partner registered, still open and not already lapsed', () => {
    const old = { assignedAt: ago(100) };
    expect(t.proofAction(lead({ ...old, addedByPartnerId: null }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ ...old, status: 'CLOSED' }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ ...old, status: 'DROPPED' }), NOW, 72)).toBe('none');
    expect(t.proofAction(lead({ ...old, registrationLapsedAt: ago(1) }), NOW, 72)).toBe('none');
  });
  test('off when the hours are 0', () => {
    expect(t.proofAction(lead({ assignedAt: ago(500) }), NOW, 0)).toBe('none');
    expect(t.proofAction(lead({ assignedAt: ago(500) }), NOW, undefined)).toBe('none');
  });
});

describe('a lapsed registration frees the buyer', () => {
  const reg = (over = {}) => ({ id: 'r1', addedByPartnerId: 'A', createdAt: ago(24 * 5), ...over });
  test('while it stands, the registering partner holds the buyer and another partner is not credited', () => {
    expect(decideBuyerOwnership({ priorLeads: [reg()], partnerId: 'B', windowDays: 30, asOf: NOW })).toMatchObject({ credited: false, reason: 'OTHER_PARTNER' });
  });
  test('once lapsed it counts for nothing: another partner is credited as if the buyer were new', () => {
    expect(decideBuyerOwnership({ priorLeads: [reg({ registrationLapsedAt: ago(24) })], partnerId: 'B', windowDays: 30, asOf: NOW })).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
  });
  test('a lapsed registration does not make the buyer "ours" either', () => {
    expect(decideBuyerOwnership({ priorLeads: [reg({ registrationLapsedAt: ago(24) })], partnerId: 'A', windowDays: 30, asOf: NOW }).reason).toBe('NEW_BUYER');
  });
  test('an earlier platform lead still makes the buyer ours', () => {
    const ours = { id: 'o1', addedByPartnerId: null, createdAt: ago(24 * 9) };
    expect(decideBuyerOwnership({ priorLeads: [reg({ registrationLapsedAt: ago(24) }), ours], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('EXISTING_BUYER');
  });
  test('the hold is 30 days from the last activity', () => {
    expect(decideBuyerOwnership({ priorLeads: [reg({ createdAt: ago(24 * 29) })], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('OTHER_PARTNER');
    expect(decideBuyerOwnership({ priorLeads: [reg({ createdAt: ago(24 * 31) })], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('NEW_BUYER');
  });
});

describe('the hourly job: proof window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfigNumber.mockResolvedValue(0);
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 30, partnerLeadProofHours: 72 });
    prisma.lead.update.mockResolvedValue({});
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.lead.findMany.mockImplementation(async ({ where }) => (where.registrationLapsedAt ? PROOF_ROWS : []));
  });
  let PROOF_ROWS = [];

  test('lapses a lead with no sign of life: back to the pool, marked lapsed, the partner and admins told', async () => {
    PROOF_ROWS = [lead({ id: 'x', assignedAt: ago(80) })];
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ lapsed: 1, proofWarned: 0 });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'x' }, data: { registrationLapsedAt: NOW, assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null, responseReminderAt: null } });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'A', title: 'Registration lapsed' }));
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
  test('a lead sitting in the pool (not held by the adder) is marked lapsed but its assignment is not touched', async () => {
    PROOF_ROWS = [lead({ id: 'p', status: 'UNASSIGNED', assignedPartnerId: null, assignedAt: null, createdAt: ago(80) })];
    await job.runOnce(NOW);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'p' }, data: { registrationLapsedAt: NOW } });
  });
  test('a buyer who signed up with that number (verified) keeps the registration alive', async () => {
    PROOF_ROWS = [lead({ id: 'y', assignedAt: ago(100) })];
    prisma.user.findFirst.mockResolvedValue({ id: 'buyer1' });
    const out = await job.runOnce(NOW);
    expect(out.lapsed).toBe(0);
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ phone: '+919000000001', role: 'USER', phoneVerified: true });
  });
  test('warns once at two thirds of the time, telling the partner how long is left', async () => {
    PROOF_ROWS = [lead({ id: 'w', assignedAt: ago(50) })];
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ proofWarned: 1, lapsed: 0 });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'w' }, data: { proofWarnedAt: NOW } });
    expect(createNotification.mock.calls[0][0].message).toMatch(/24 hours/);
  });
  test('only reads open leads a partner registered that have not lapsed; leads waiting for admin are never read', async () => {
    PROOF_ROWS = [];
    await job.runOnce(NOW);
    const where = prisma.lead.findMany.mock.calls.map(([a]) => a.where).find((w) => w.registrationLapsedAt);
    expect(where).toMatchObject({ addedByPartnerId: { isSet: true }, registrationLapsedAt: { isSet: false }, status: { in: ['ASSIGNED', 'UNASSIGNED'] } });
  });
  test('switched off with 0 hours: nothing is read for it and nothing lapses', async () => {
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 30, partnerLeadProofHours: 0 });
    PROOF_ROWS = [lead({ assignedAt: ago(500) })];
    const out = await job.runOnce(NOW);
    expect(out.lapsed).toBe(0);
    expect(prisma.lead.findMany.mock.calls.some(([a]) => a.where.status && a.where.status.in)).toBe(false);
  });
});
