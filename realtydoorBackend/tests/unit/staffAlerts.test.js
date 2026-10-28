// 28 Oct 2026: staff alert emails (ADMIN_ALERT_EMAILS), the failed-payout messages, and the twice-daily digest.
const mockSend = jest.fn().mockResolvedValue({});
jest.mock('../../src/lib/email', () => ({ send: (...a) => mockSend(...a), sendPartnerPayoutFailed: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn() },
  escrowTransaction: { count: jest.fn() },
  dispute: { count: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const email = require('../../src/lib/email');
const { notifyUser } = require('../../src/lib/wati');
const { createNotification } = require('../../src/lib/notifications');
const { alertStaff, recipients } = require('../../src/lib/staffAlerts');
const { onPayoutFailed } = require('../../src/lib/payoutAlerts');
const { sendDigest, buildDigest } = require('../../src/jobs/staffDigest');

beforeEach(() => { jest.clearAllMocks(); delete process.env.ADMIN_ALERT_EMAILS; });

describe('alertStaff', () => {
  test('unset ADMIN_ALERT_EMAILS sends nothing', async () => {
    expect(await alertStaff('x', '<p>y</p>')).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
  test('sends one email per address with a [Realtydoor] subject', async () => {
    const env = { ADMIN_ALERT_EMAILS: 'a@x.test, b@x.test' };
    expect(recipients(env)).toEqual(['a@x.test', 'b@x.test']);
    expect(await alertStaff('Escrow payout failed', '<p>y</p>', env)).toBe(2);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'a@x.test', subject: '[Realtydoor] Escrow payout failed' });
  });
  test('one failing mailbox does not stop the others or throw', async () => {
    mockSend.mockRejectedValueOnce(new Error('smtp'));
    expect(await alertStaff('s', 'h', { ADMIN_ALERT_EMAILS: 'a@x.test,b@x.test' })).toBe(1);
  });
});

describe('onPayoutFailed', () => {
  const escrow = { id: 'e1', leadId: 'l1', amount: 50000 };
  beforeEach(() => {
    process.env.ADMIN_ALERT_EMAILS = 'ops@x.test';
    prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-000105', assignedPartnerId: 'p1' });
    prisma.user.findUnique.mockResolvedValue({ email: 'dev1@x.test' });
  });
  test('partner leg: staff are emailed and the partner is told in the app, on WhatsApp and by email, without the bank reason', async () => {
    await onPayoutFailed({ escrow, leg: 'partner', status: 'failed', reason: 'Account 1234 closed' });
    expect(mockSend.mock.calls[0][0].subject).toContain('Escrow payout failed');
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1', type: 'PAYOUT_FAILED' }));
    expect(JSON.stringify(createNotification.mock.calls[0][0])).not.toContain('1234');
    expect(notifyUser).toHaveBeenCalledWith('p1', 'partner_payout_failed', { partner_name: '$userName', lead_ref: 'RD-L-000105' }, { leadId: 'l1' });
    expect(email.sendPartnerPayoutFailed).toHaveBeenCalledWith('dev1@x.test', { leadRef: 'RD-L-000105' });
  });
  test('seller leg: only staff are told', async () => {
    await onPayoutFailed({ escrow, leg: 'seller', status: 'reversed', reason: 'x' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
  test('never throws', async () => {
    prisma.lead.findUnique.mockRejectedValue(new Error('db down'));
    await expect(onPayoutFailed({ escrow, leg: 'partner', status: 'failed' })).resolves.toBeUndefined();
  });
});

describe('staff digest', () => {
  const counts = (u, p, d) => { prisma.lead.count.mockResolvedValue(u); prisma.escrowTransaction.count.mockResolvedValue(p); prisma.dispute.count.mockResolvedValue(d); };
  test('counts leads unassigned past the 4-hour SLA', async () => {
    counts(0, 0, 0);
    await buildDigest(new Date('2026-10-28T10:00:00Z'));
    const where = prisma.lead.count.mock.calls[0][0].where;
    expect(where.status).toBe('UNASSIGNED');
    expect(where.createdAt.lte.toISOString()).toBe('2026-10-28T06:00:00.000Z');
  });
  test('sends one email listing what is waiting', async () => {
    counts(8, 1, 3);
    expect(await sendDigest(new Date(), { ADMIN_ALERT_EMAILS: 'ops@x.test' })).toBe(true);
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('<strong>8</strong> lead(s)');
    expect(html).toContain('<strong>1</strong> escrow(s)');
    expect(html).toContain('<strong>3</strong> open dispute(s)');
  });
  test('nothing waiting means no email, and no recipients means no queries', async () => {
    counts(0, 0, 0);
    expect(await sendDigest(new Date(), { ADMIN_ALERT_EMAILS: 'ops@x.test' })).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    prisma.lead.count.mockClear();
    expect(await sendDigest(new Date(), {})).toBe(false);
    expect(prisma.lead.count).not.toHaveBeenCalled();
  });
  test('is registered with the other jobs', () => {
    expect(require('../../src/jobs').JOB_MODULES).toContain('./staffDigest');
  });
});
