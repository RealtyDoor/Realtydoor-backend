// Owner, 24 Oct: a loan application must say which property it is for; it was optional, and a typed-in id at that.
jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn() }, user: { findUnique: jest.fn().mockResolvedValue({ name: 'Krishna' }) }, $transaction: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue(undefined), createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn() }));
const prisma = require('../../src/lib/prisma');
const { createLoanSchema } = require('../../src/modules/users/users.validator');
const users = require('../../src/modules/users/users.service');

const PID = '6a44a67c287fb9ab18e3fc55';
const body = { preferredBank: 'SBI', loanAmountRequestedPaise: 500000000, documentSharingConsent: true };

beforeEach(() => jest.clearAllMocks());

describe('loan application needs a property', () => {
  test('the request is refused without one, and with a malformed one', () => {
    expect(createLoanSchema.safeParse(body).success).toBe(false);
    expect(createLoanSchema.safeParse({ ...body, propertyId: 'not-an-id' }).success).toBe(false);
    expect(createLoanSchema.safeParse({ ...body, propertyId: PID }).success).toBe(true);
  });

  test('a property without a paid, visited inquiry of the buyer is refused, and nothing is written', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(users.createLoanApplication('u1', { ...body, propertyId: PID })).rejects.toMatchObject({ statusCode: 400, data: { code: 'LOAN_PROPERTY_NOT_YOURS' } });
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ buyerId: 'u1', propertyId: PID, status: { in: ['SITE_VISIT_DONE', 'CLOSED'] } });
    expect(where.escrowTransactions.some.status.in).toEqual(expect.arrayContaining(['HELD', 'RELEASED']));
    expect(where.escrowTransactions.some.status.in).not.toContain('REFUNDED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('a named inquiry must be the buyer\'s own, for that property, and visited and paid', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    const LID = '6a44a67c287fb9ab18e3fc99';
    await expect(users.createLoanApplication('u1', { ...body, propertyId: PID, leadId: LID })).rejects.toMatchObject({ data: { code: 'LOAN_PROPERTY_NOT_YOURS' } });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toMatchObject({ id: LID, buyerId: 'u1', propertyId: PID });
    expect(createLoanSchema.safeParse({ ...body, propertyId: PID, leadId: LID }).success).toBe(true);
    expect(createLoanSchema.safeParse({ ...body, propertyId: PID, leadId: 'nope' }).success).toBe(false);
  });

  test('a visited, paid inquiry goes on to the normal checks', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1' });
    prisma.$transaction.mockResolvedValue({ id: 'loan1' });
    await expect(users.createLoanApplication('u1', { ...body, propertyId: PID })).resolves.toEqual({ id: 'loan1' });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
