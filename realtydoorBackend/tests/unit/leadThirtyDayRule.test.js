// 4 Nov 2026: one 30-day hold for every lead. Partner-added leads lapse at the end; company-given leads nudge admin at day 20 and ask for a
// decision at day 30. A pending extension pauses the clock. A booked visit nobody attends stops counting after 7 days.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(0) }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const t = require('../../src/lib/leadTimers');
const { lastActivity, decideBuyerOwnership } = require('../../src/lib/leadOwnership');
const { salesWhere } = require('../../src/lib/leadSales');
const job = require('../../src/jobs/leadHygiene');

const NOW = new Date('2026-11-04T10:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86_400_000);
const mine = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', buyerName: 'Meena', buyerPhone: '+919000000001', status: 'ASSIGNED', addedByPartnerId: 'A', assignedPartnerId: 'A', assignedAt: day(10), createdAt: over.assignedAt || day(11), escrowTransactions: [], ...over });
const given = (over = {}) => mine({ addedByPartnerId: null, assignedPartnerId: 'P', ...over });

describe('holdAction: partner-added lead', () => {
  test('inside 30 days nothing happens; at 30 days with no activity it lapses', () => {
    expect(t.holdAction(mine({ assignedAt: day(29) }), NOW, 30)).toBe('none');
    expect(t.holdAction(mine({ assignedAt: day(31) }), NOW, 30)).toBe('lapse');
  });
  test('an approved 10-day extension moves the end out', () => {
    const l = { assignedAt: day(35), holdExtensionRequestedAt: day(8), holdExtensionDecidedAt: day(7), holdExtensionApproved: true, holdExtensionDays: 10 };
    expect(t.holdAction(mine(l), NOW, 30)).toBe('none');
    expect(t.holdAction(mine({ ...l, assignedAt: day(41) }), NOW, 30)).toBe('lapse');
  });
  test('a pending request pauses the clock, so a slow admin never costs the partner the buyer', () => {
    expect(t.holdAction(mine({ assignedAt: day(33), holdExtensionRequestedAt: day(2) }), NOW, 30)).toBe('none');
  });
  test('a declined request lets it end as planned', () => {
    expect(t.holdAction(mine({ assignedAt: day(33), holdExtensionRequestedAt: day(2), holdExtensionDecidedAt: day(1), holdExtensionApproved: false }), NOW, 30)).toBe('lapse');
  });
  test('money held, lapsed, closed, dropped and waiting-for-admin leads are left alone', () => {
    const old = { assignedAt: day(60) };
    expect(t.holdAction(mine({ ...old, escrowTransactions: [{ status: 'HELD' }] }), NOW, 30)).toBe('none');
    expect(t.holdAction(mine({ ...old, registrationLapsedAt: day(1) }), NOW, 30)).toBe('none');
    for (const status of ['CLOSED', 'DROPPED', 'AWAITING_ADMIN']) expect(t.holdAction(mine({ ...old, status }), NOW, 30)).toBe('none');
    expect(t.holdAction(given(old), NOW, 30)).toBe('none');
    expect(t.holdAction(mine(old), NOW, 0)).toBe('none');
  });
  test('a verified visit restarts the 30 days', () => {
    expect(t.holdAction(mine({ assignedAt: day(60), otpVerifiedAt: day(10), isOtpVerified: true }), NOW, 30)).toBe('none');
  });
});

describe('assignedLeadAction: a lead the company gave a partner', () => {
  test('nothing before day 20; one nudge at day 20; one notice at day 30', () => {
    expect(t.assignedLeadAction(given({ assignedAt: day(19) }), NOW, 30, 20)).toBe('none');
    expect(t.assignedLeadAction(given({ assignedAt: day(21) }), NOW, 30, 20)).toBe('nudge');
    expect(t.assignedLeadAction(given({ assignedAt: day(21), assignmentNudgedAt: day(1) }), NOW, 30, 20)).toBe('none');
    expect(t.assignedLeadAction(given({ assignedAt: day(31), assignmentNudgedAt: day(10) }), NOW, 30, 20)).toBe('due');
    expect(t.assignedLeadAction(given({ assignedAt: day(31), assignmentDueNotifiedAt: day(1) }), NOW, 30, 20)).toBe('none');
  });
  test('an approved extension delays the notice; a pending request pauses it', () => {
    expect(t.assignedLeadAction(given({ assignedAt: day(35), holdExtensionApproved: true, holdExtensionDays: 10, holdExtensionRequestedAt: day(8), holdExtensionDecidedAt: day(7), assignmentNudgedAt: day(10) }), NOW, 30, 20)).toBe('none');
    expect(t.assignedLeadAction(given({ assignedAt: day(35), holdExtensionRequestedAt: day(1) }), NOW, 30, 20)).toBe('none');
  });
  test('partner-brought leads, money held and activity are not nudged', () => {
    expect(t.assignedLeadAction(mine({ assignedAt: day(40) }), NOW, 30, 20)).toBe('none');
    expect(t.assignedLeadAction(given({ assignedAt: day(40), escrowTransactions: [{ status: 'HELD' }] }), NOW, 30, 20)).toBe('none');
    expect(t.assignedLeadAction(given({ assignedAt: day(40), otpVerifiedAt: day(3), isOtpVerified: true }), NOW, 30, 20)).toBe('none');
  });
});

describe('a booked visit nobody attends', () => {
  test('an attended visit always counts', () => {
    expect(lastActivity({ createdAt: day(40), siteVisitScheduledAt: day(20), otpVerifiedAt: day(20), visitNoShowConfirmedAt: day(1) }, NOW)).toBe(day(20).getTime());
  });
  test('once a person confirms the no-show it no longer holds the buyer against another partner', () => {
    const stale = { id: 'p', addedByPartnerId: 'A', createdAt: day(40), siteVisitScheduledAt: day(12), visitNoShowConfirmedAt: day(2), escrowTransactions: [] };
    expect(decideBuyerOwnership({ priorLeads: [stale], partnerId: 'B', windowDays: 30, asOf: NOW })).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
    expect(decideBuyerOwnership({ priorLeads: [{ ...stale, visitNoShowConfirmedAt: undefined }], partnerId: 'B', windowDays: 30, asOf: NOW })).toMatchObject({ credited: false, reason: 'OTHER_PARTNER' });
  });
});

describe('the hourly job', () => {
  let ROWS;
  beforeEach(() => {
    jest.clearAllMocks();
    ROWS = [];
    prisma.lead.update.mockResolvedValue({});
    prisma.lead.findMany.mockImplementation(async ({ where }) => ROWS.filter((r) => matches(r, where)));
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 30, partnerLeadProofHours: 0, partnerLeadNudgeDays: 20, leadLateHours: 48, leadLateEscalateDays: 5 });
  });
  // Just enough of a where-matcher for these queries.
  function matches(r, w) {
    if (w.OR) return false; // the warning step: not under test here
    if (w.status === 'AWAITING_ADMIN') return r.status === 'AWAITING_ADMIN' && r.createdAt < w.createdAt.lt && (w.lateEscalatedAt ? !r.lateEscalatedAt : !r.lateNotifiedAt);
    if (w.holdExtensionRequestedAt) return !!r.holdExtensionRequestedAt && r.holdExtensionRequestedAt < w.holdExtensionRequestedAt.lt && !r.holdExtensionDecidedAt && (w.holdExtensionEscalatedFiveAt ? !r.holdExtensionEscalatedFiveAt : !r.holdExtensionEscalatedAt);
    if (w.addedByPartnerId?.isSet === true) return !!r.addedByPartnerId && !r.registrationLapsedAt && !['CLOSED', 'DROPPED', 'AWAITING_ADMIN'].includes(r.status);
    if (w.addedByPartnerId?.isSet === false) return !r.addedByPartnerId && !!r.assignedPartnerId && r.status === 'ASSIGNED';
    return false;
  }

  test('a partner-added lead past its 30 days lapses: back to the pool, partner and admins told', async () => {
    ROWS = [mine({ id: 'x', assignedAt: day(40) })];
    const out = await job.runOnce(NOW);
    expect(out.holdLapsed).toBe(1);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'x' }, data: { registrationLapsedAt: NOW, assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null, responseReminderAt: null } });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'A', title: 'Registration lapsed' }));
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
  test('a lead inside its window, or with a pending request, is left alone', async () => {
    ROWS = [mine({ id: 'a', assignedAt: day(10) }), mine({ id: 'b', assignedAt: day(40), holdExtensionRequestedAt: day(1) })];
    expect((await job.runOnce(NOW)).holdLapsed).toBe(0);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('company-given leads: a nudge to admin at day 20, nothing moved', async () => {
    ROWS = [given({ id: 'g', assignedAt: day(22) })];
    const out = await job.runOnce(NOW);
    expect(out.nudged).toBe(1);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'g' }, data: { assignmentNudgedAt: NOW } });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'A given lead has gone quiet', linkUrl: '/admin/leads/g' }));
  });
  test('company-given leads: a decision request at day 30; the lead stays with the partner', async () => {
    ROWS = [given({ id: 'g', assignedAt: day(32), assignmentNudgedAt: day(12) })];
    const out = await job.runOnce(NOW);
    expect(out.due).toBe(1);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'g' }, data: { assignmentDueNotifiedAt: NOW } });
  });
  test('slow admin: a registration waiting over 48 hours and an undecided request are each escalated once', async () => {
    ROWS = [
      { id: 'w', refCode: 'RD-L-W', status: 'AWAITING_ADMIN', createdAt: day(3) },
      { id: 'e', refCode: 'RD-L-E', status: 'ASSIGNED', createdAt: day(20), holdExtensionRequestedAt: day(3) },
    ];
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ late: 1, extensionLate: 1 });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'w' }, data: { lateNotifiedAt: NOW } });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'e' }, data: { holdExtensionEscalatedAt: NOW } });
  });
  test('a second, stronger alert after 5 days, once, on top of the 48-hour one', async () => {
    ROWS = [
      { id: 'w', refCode: 'RD-L-W', status: 'AWAITING_ADMIN', createdAt: day(6), lateNotifiedAt: day(4) },
      { id: 'e', refCode: 'RD-L-E', status: 'ASSIGNED', createdAt: day(30), holdExtensionRequestedAt: day(6), holdExtensionEscalatedAt: day(4) },
      { id: 'n', refCode: 'RD-L-N', status: 'AWAITING_ADMIN', createdAt: day(3) },
    ];
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ lateFive: 1, extensionLateFive: 1 });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'w' }, data: { lateEscalatedAt: NOW } });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'e' }, data: { holdExtensionEscalatedFiveAt: NOW } });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'Registration waiting 5 days' }));
  });
  test('the 30-day rule is off when the window is 0', async () => {
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 0, partnerLeadProofHours: 0, partnerLeadNudgeDays: 20, leadLateHours: 0 });
    ROWS = [mine({ assignedAt: day(90) }), given({ assignedAt: day(90) })];
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ holdLapsed: 0, nudged: 0, due: 0 });
  });
});

describe('admin filters', () => {
  test('late and given', () => {
    expect(JSON.stringify(salesWhere({ late: '1' }, 'me', NOW))).toContain('AWAITING_ADMIN');
    expect(salesWhere({ given: '1' }, 'me', NOW)).toEqual({ AND: [{ status: 'ASSIGNED', addedByPartnerId: { isSet: false }, assignmentNudgedAt: { isSet: true } }] });
  });
});

describe('no-show is confirmed by a person (4 Nov 2026)', () => {
  test('a booked visit keeps counting until someone confirms the no-show', () => {
    const l = { createdAt: day(40), siteVisitScheduledAt: day(12) };
    expect(lastActivity(l, NOW)).toBe(day(12).getTime());
    expect(lastActivity({ ...l, visitNoShowConfirmedAt: day(1) }, NOW)).toBe(day(40).getTime());
  });
  test('7 days after the slot with nobody attending: flag to admin once', () => {
    const l = { siteVisitScheduledAt: day(8), status: 'ASSIGNED' };
    expect(t.noShowAction(l, NOW)).toBe('flag');
    expect(t.noShowAction({ ...l, siteVisitScheduledAt: day(5) }, NOW)).toBe('none');
    expect(t.noShowAction({ ...l, noShowFlaggedAt: day(1) }, NOW)).toBe('none');
    expect(t.noShowAction({ ...l, isOtpVerified: true }, NOW)).toBe('none');
    expect(t.noShowAction({ ...l, visitNoShowConfirmedAt: day(1) }, NOW)).toBe('none');
  });
});
