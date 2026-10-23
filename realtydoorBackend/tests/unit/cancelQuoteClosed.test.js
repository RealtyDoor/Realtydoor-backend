// BUG-054: the cancel quote must not promise a refund for an inquiry that cancelLead will refuse.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn() },
  escrowTransaction: { findFirst: jest.fn() },
}));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ refund: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const escrowService = require('../../src/modules/escrow/escrow.service');
const users = require('../../src/modules/users/users.service');

beforeEach(() => jest.clearAllMocks());

describe('getCancelQuote', () => {
  test('a closed or dropped inquiry with a held token is not refundable', async () => {
    for (const status of ['CLOSED', 'DROPPED']) {
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status });
      prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
      await expect(users.getCancelQuote('u1', 'l1')).resolves.toEqual({ hasEscrow: true, escrowId: 'e1', stage: 'CLOSED', refundable: false });
    }
    expect(escrowService.refund).not.toHaveBeenCalled();
  });
  test('an open inquiry still gets the real quote', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'SITE_VISIT_DONE' });
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
    escrowService.refund.mockResolvedValue({ stage: 'WITHIN_WINDOW', refundable: true, refundPaise: 5000000 });
    await expect(users.getCancelQuote('u1', 'l1')).resolves.toMatchObject({ hasEscrow: true, escrowId: 'e1', stage: 'WITHIN_WINDOW', refundable: true });
  });
  test('someone else\'s lead is still a 404 and no escrow is read', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(users.getCancelQuote('u2', 'l1')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.escrowTransaction.findFirst).not.toHaveBeenCalled();
  });
});
