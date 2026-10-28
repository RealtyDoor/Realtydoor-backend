// The WhatsApp and email messages added on 28 Oct 2026 (refund and cancel, token held, tax invoice needed, visit
// scheduled, ticket and dispute updates, video tour, payout processed, visit reminder).

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'm1', accepted: ['a@b.c'] });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: (...a) => mockSendMail(...a) }) }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn() },
  user: { findUnique: jest.fn() },
  watiMessageLog: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn().mockResolvedValue(null) }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyUser } = require('../../src/lib/wati');
const email = require('../../src/lib/email');
const { sendDueReminders } = require('../../src/jobs/visitReminder');

const lastHtml = () => mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1][0];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.example.test';
});

describe('refund email', () => {
  test('keeps the short wording when no detail is passed', async () => {
    await email.sendEscrowRefunded('a@b.c', 50000);
    expect(lastHtml().html).toContain('₹50,000');
    expect(lastHtml().html).not.toContain('cancellation charge');
  });

  test('names the charge kept and says the fee is not returned', async () => {
    await email.sendEscrowRefunded('a@b.c', 47001, { chargeRupees: 2999, feeReturned: false, propertyTitle: 'Vrunda City' });
    const { html } = lastHtml();
    expect(html).toContain('Vrunda City');
    expect(html).toContain('₹2,999');
    expect(html).toContain('processing fee is not returned');
  });

  test('says the fee is returned when it is', async () => {
    await email.sendEscrowRefunded('a@b.c', 51209, { chargeRupees: 0, feeReturned: true });
    expect(lastHtml().html).toContain('processing fee is returned too');
    expect(lastHtml().html).not.toContain('cancellation charge');
  });
});

describe('new emails', () => {
  test('visit scheduled: has the time and the inquiry link, never a code', async () => {
    await email.sendVisitScheduled('a@b.c', { propertyTitle: 'Divine', whenText: 'Thu, 29 Oct, 3:00 pm IST', partnerName: 'Dev', leadId: 'L1' });
    const { subject, html } = lastHtml();
    expect(subject).toContain('Divine');
    expect(html).toContain('Thu, 29 Oct, 3:00 pm IST');
    expect(html).toContain('https://app.example.test/user/inquiries/L1');
    expect(html).not.toMatch(/\b\d{6}\b/);
  });

  test('anything typed by a person is escaped', async () => {
    await email.sendTicketUpdate('a@b.c', { subject: '<script>x</script>', update: 'a "quote" & more', ticketId: 'T1' });
    const { html } = lastHtml();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quote&quot; &amp; more');
  });

  test('dispute update shows the status and the note', async () => {
    await email.sendDisputeUpdate('a@b.c', { status: 'resolved', note: 'Refund sent' });
    expect(lastHtml().subject).toBe('Your report is resolved');
    expect(lastHtml().html).toContain('Refund sent');
  });

  test('video tour: scheduled and completed read differently', async () => {
    await email.sendVideoTourUpdate('a@b.c', { propertyTitle: 'Divine', whenText: 'Fri, 30 Oct, 9:00 pm IST', completed: false });
    expect(lastHtml().subject).toBe('Your video tour is scheduled');
    expect(lastHtml().html).toContain('Fri, 30 Oct, 9:00 pm IST');
    await email.sendVideoTourUpdate('a@b.c', { propertyTitle: 'Divine', completed: true });
    expect(lastHtml().subject).toBe('Your video tour is ready');
  });

  test('partner payout and tax-invoice emails link to Payouts and paperwork', async () => {
    await email.sendPartnerPayoutProcessed('p@b.c', { amountRupees: 52500, utr: 'UTR1', leadRef: 'RD-L-000105' });
    expect(lastHtml().html).toContain('₹52,500');
    expect(lastHtml().html).toContain('UTR1');
    expect(lastHtml().html).toContain('/partners/finance/payouts');
    await email.sendPartnerTaxInvoiceNeeded('p@b.c', { leadRef: 'RD-L-000105' });
    expect(lastHtml().subject).toBe('Upload your tax invoice to get paid');
    expect(lastHtml().html).toContain('RD-L-000105');
  });
});

describe('tax invoice and payout-failed emails', () => {
  test('accepted: says the payout can go ahead', async () => {
    await email.sendTaxInvoiceReviewed('p@b.c', { accepted: true, invoiceNumber: 'INV-1' });
    expect(lastHtml().subject).toBe('Your tax invoice was accepted');
    expect(lastHtml().html).toContain('INV-1');
    expect(lastHtml().html).toContain('payout can now go ahead');
  });
  test('rejected: shows the reason, escaped', async () => {
    await email.sendTaxInvoiceReviewed('p@b.c', { accepted: false, invoiceNumber: 'INV-1', reason: 'GSTIN <wrong>' });
    expect(lastHtml().subject).toBe('Your tax invoice needs a correction');
    expect(lastHtml().html).toContain('GSTIN &lt;wrong&gt;');
  });
  test('payout failed: no bank reason, links to finance', async () => {
    await email.sendPartnerPayoutFailed('p@b.c', { leadRef: 'RD-L-000105' });
    expect(lastHtml().html).toContain('RD-L-000105');
    expect(lastHtml().html).toContain('/partners/finance');
  });
});

describe('visit reminder job', () => {
  const visit = (over = {}) => ({
    id: 'L1', buyerId: 'B1', siteVisitScheduledAt: new Date('2026-10-29T09:30:00Z'), propertyInterest: null,
    property: { title: 'Divine' }, assignedPartner: { name: 'Dev', companyName: null }, ...over,
  });

  test('sends one reminder for a visit in the next 1 to 3 hours, with no code in it', async () => {
    prisma.lead.findMany.mockResolvedValue([visit()]);
    prisma.user.findUnique.mockResolvedValue({ notifVisitReminders: true });
    prisma.watiMessageLog.findFirst.mockResolvedValue(null);
    const now = new Date('2026-10-29T07:00:00Z');
    expect(await sendDueReminders(now)).toBe(1);
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('SITE_VISIT_SCHEDULED');
    expect(where.siteVisitScheduledAt.gte.toISOString()).toBe('2026-10-29T08:00:00.000Z');
    expect(where.siteVisitScheduledAt.lte.toISOString()).toBe('2026-10-29T10:00:00.000Z');
    const [userId, template, params, context] = notifyUser.mock.calls[0];
    expect(userId).toBe('B1');
    expect(template).toBe('visit_reminder_v2');
    expect(params).toMatchObject({ name: '$userName', property_title: 'Divine', partner_name: 'Dev' });
    expect(params.visit_time).toContain('3:00 pm');
    expect(Object.values(params).join(' ')).not.toMatch(/\b\d{6}\b/);
    expect(context).toEqual({ leadId: 'L1' });
  });

  test('does not send twice for the same lead', async () => {
    prisma.lead.findMany.mockResolvedValue([visit()]);
    prisma.user.findUnique.mockResolvedValue({ notifVisitReminders: true });
    prisma.watiMessageLog.findFirst.mockResolvedValue({ id: 'log1' });
    expect(await sendDueReminders(new Date('2026-10-29T07:00:00Z'))).toBe(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  test('respects the buyer turning visit reminders off', async () => {
    prisma.lead.findMany.mockResolvedValue([visit()]);
    prisma.user.findUnique.mockResolvedValue({ notifVisitReminders: false });
    expect(await sendDueReminders(new Date('2026-10-29T07:00:00Z'))).toBe(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  test('is registered with the other jobs', () => {
    expect(require('../../src/jobs').JOB_MODULES).toContain('./visitReminder');
  });
});

describe('EMAIL_ALLOWED_RECIPIENTS (test runs cannot email real people)', () => {
  const { isRecipientAllowed } = email;
  test('unset means no limit', () => {
    expect(isRecipientAllowed('anyone@example.com', {})).toBe(true);
  });
  test('an address or a whole domain can be allowed; others are blocked', () => {
    const env = { EMAIL_ALLOWED_RECIPIENTS: 'dev0@realtydoor.com, @mockqa.test' };
    expect(isRecipientAllowed('DEV0@realtydoor.com', env)).toBe(true);
    expect(isRecipientAllowed('x@mockqa.test', env)).toBe(true);
    expect(isRecipientAllowed('real.person@gmail.com', env)).toBe(false);
  });
  test('production ignores the list', () => {
    expect(isRecipientAllowed('real.person@gmail.com', { NODE_ENV: 'production', EMAIL_ALLOWED_RECIPIENTS: 'a@b.c' })).toBe(true);
  });
  test('send() skips a blocked recipient without calling the mail server', async () => {
    process.env.EMAIL_ALLOWED_RECIPIENTS = 'only@me.test';
    expect(await email.send({ to: 'other@x.test', subject: 's', html: 'h' })).toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
    delete process.env.EMAIL_ALLOWED_RECIPIENTS;
  });
});
