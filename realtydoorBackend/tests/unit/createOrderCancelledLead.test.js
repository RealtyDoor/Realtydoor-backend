// Owner, 24 Oct: "not able to pay" on a lead whose token was cancelled and refunded. The inquiry is DROPPED then, and the error said only
// "Escrow can only be created after the site visit is done", which tells the buyer nothing.
jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn() }, escrowTransaction: { findFirst: jest.fn() } }));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: {}, createEscrowOrder: jest.fn(), createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(), refundPayment: jest.fn() }));
const prisma = require('../../src/lib/prisma');
const escrow = require('../../src/modules/escrow/escrow.service');

beforeEach(() => jest.clearAllMocks());

test('a cancelled (dropped) inquiry says so and how to go on, with a code the app can use', async () => {
  prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'DROPPED', property: { price: 5000000 } });
  await expect(escrow.createOrder('l1', 'u1', 50000)).rejects.toMatchObject({
    statusCode: 400,
    data: { code: 'LEAD_DROPPED' },
    message: expect.stringMatching(/cancelled.*new inquiry/i),
  });
});

test('a closed inquiry is told it is already complete', async () => {
  prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'CLOSED', property: { price: 5000000 } });
  await expect(escrow.createOrder('l1', 'u1', 50000)).rejects.toMatchObject({ statusCode: 400, data: { code: 'LEAD_CLOSED' } });
});

test('an inquiry still before the visit keeps the original message', async () => {
  prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'VISIT_SCHEDULED', property: { price: 5000000 } });
  await expect(escrow.createOrder('l1', 'u1', 50000)).rejects.toMatchObject({ statusCode: 400, message: 'Escrow can only be created after the site visit is done' });
});
