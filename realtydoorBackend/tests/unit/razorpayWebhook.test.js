// The Razorpay webhook is a public endpoint that moves money state. These tests call the handler directly with every
// collaborator mocked: signature refusal, redelivery (replay), out-of-order events, partial and full refunds, payout results,
// and hostile payloads (which must become a clean 400/500, never a crash).
jest.mock('../../src/lib/razorpay', () => ({ verifyWebhookSignature: jest.fn() }));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ confirmPayment: jest.fn() }));
jest.mock('../../src/modules/services/services.service', () => ({ activateSubscription: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowPaymentFailed: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(() => Promise.resolve()), broadcastNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPayoutStatus: jest.fn(() => Promise.resolve()), onRefund: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/modules/escrow/escrowPayout.service', () => ({ adoptPayout: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../../src/lib/prisma', () => ({
  webhookEvent: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(() => Promise.resolve()) },
  escrowTransaction: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(() => Promise.resolve()), updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
  userSubscription: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(() => Promise.resolve()) },
  user: { findUnique: jest.fn(), findMany: jest.fn(() => Promise.resolve([{ id: 'adm1' }])) },
  lead: { findUnique: jest.fn() },
  commissionVoucher: { updateMany: jest.fn(() => Promise.resolve()) },
}));

const prisma = require('../../src/lib/prisma');
const { verifyWebhookSignature } = require('../../src/lib/razorpay');
const { confirmPayment } = require('../../src/modules/escrow/escrow.service');
const { activateSubscription } = require('../../src/modules/services/services.service');
const { createNotification, broadcastNotification } = require('../../src/lib/notifications');
const ledger = require('../../src/modules/money/ledger.service');
const { razorpay } = require('../../src/modules/webhooks/webhooks.controller');

function call(body, { eventId = 'evt_1', signature = 'sig' } = {}) {
  const req = { headers: { 'x-razorpay-signature': signature, ...(eventId ? { 'x-razorpay-event-id': eventId } : {}) }, rawBody: Buffer.from(JSON.stringify(body || {})), body };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return razorpay(req, res).then(() => res);
}
const captured = (orderId = 'order_1', id = 'pay_1') => ({ event: 'payment.captured', payload: { payment: { entity: { order_id: orderId, id } } } });
const dupError = Object.assign(new Error('dup'), { code: 'P2002' });

beforeEach(() => {
  verifyWebhookSignature.mockReturnValue(true);
  prisma.webhookEvent.create.mockResolvedValue({});
});

describe('signature', () => {
  test('a bad or missing signature is a 400 and nothing is read or changed', async () => {
    verifyWebhookSignature.mockReturnValue(false);
    const res = await call(captured(), { signature: undefined });
    expect(res.statusCode).toBe(400);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  test('the signature is checked against the raw bytes, not the parsed body', async () => {
    await call(captured());
    expect(verifyWebhookSignature).toHaveBeenCalledWith(expect.any(Buffer), 'sig');
  });

  test('a verifier that throws is a 500, not a crash', async () => {
    verifyWebhookSignature.mockImplementation(() => { throw new Error('boom'); });
    expect((await call(captured())).statusCode).toBe(500);
  });
});

describe('payment.captured', () => {
  test('an escrow order is confirmed once, and the event is marked processed', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1' });
    const res = await call(captured('order_9', 'pay_9'));
    expect(res.body).toEqual({ status: 'ok' });
    expect(confirmPayment).toHaveBeenCalledWith('order_9', 'pay_9', null, { amount: undefined, currency: undefined });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({ where: { eventId: 'evt_1' }, data: { processedAt: expect.any(Date) } });
  });

  test('an order that is not an escrow goes to the service subscription path', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    prisma.userSubscription.findUnique.mockResolvedValue({ id: 's1' });
    await call(captured('order_s', 'pay_s'));
    expect(activateSubscription).toHaveBeenCalledWith('order_s', 'pay_s', null, { amount: undefined, currency: undefined });
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  test('an order we do not know changes nothing and is still acknowledged', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    expect((await call(captured('order_x'))).body).toEqual({ status: 'ok' });
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(activateSubscription).not.toHaveBeenCalled();
  });

  test('REPLAY: a redelivery of an event already processed does nothing', async () => {
    prisma.webhookEvent.create.mockRejectedValue(dupError);
    prisma.webhookEvent.findUnique.mockResolvedValue({ processedAt: new Date() });
    const res = await call(captured());
    expect(res.body).toEqual({ status: 'ok' });
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.findUnique).not.toHaveBeenCalled();
  });

  test('a retry of an event that failed last time is processed again', async () => {
    prisma.webhookEvent.create.mockRejectedValue(dupError);
    prisma.webhookEvent.findUnique.mockResolvedValue({ processedAt: null, error: 'x' });
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1' });
    await call(captured());
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  test('a processing failure is a 500 (so Razorpay retries) and the error is kept on the event row', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1' });
    confirmPayment.mockRejectedValueOnce(new Error('db down'));
    const res = await call(captured());
    expect(res.statusCode).toBe(500);
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({ where: { eventId: 'evt_1' }, data: { error: 'db down' } });
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { processedAt: expect.anything() } }));
  });

  test('a failure other than a duplicate-key error while claiming the event is a 500', async () => {
    prisma.webhookEvent.create.mockRejectedValue(new Error('network'));
    expect((await call(captured())).statusCode).toBe(500);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  test('without an event id the body is still handled, with no dedup row', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1' });
    await call(captured(), { eventId: null });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(confirmPayment).toHaveBeenCalled();
  });

  // 7 Nov 2026: a validly SIGNED but malformed body used to end in a 500 ("error" and Razorpay retrying for a day) or, with no `event` name,
  // fail inside Prisma against the real database (the mocked unit test below had hidden that). A body that can never succeed is a clean 400,
  // answered before any event row is written. A real processing failure of a well-formed event is still a 500 so Razorpay retries it.
  test.each([
    ['no payload', { event: 'payment.captured' }],
    ['payload without a payment', { event: 'payment.captured', payload: {} }],
    ['a payment without an entity', { event: 'payment.captured', payload: { payment: {} } }],
    ['a payment entity that is a string', { event: 'payment.captured', payload: { payment: { entity: 'x' } } }],
    ['a failed payment without an entity', { event: 'payment.failed', payload: { payment: {} } }],
    ['a refund without an entity', { event: 'refund.created', payload: { refund: {} } }],
    ['a refund entity without a payment id', { event: 'refund.created', payload: { refund: { entity: { id: 'rfnd_1', amount: 100 } } } }],
    ['a payout event without an entity', { event: 'payout.processed', payload: {} }],
    ['a payout failure without an entity', { event: 'payout.failed', payload: { payout: {} } }],
    ['no event name', { foo: 'bar' }],
    ['an empty object', {}],
    ['an event name that is a number', { event: 12345, payload: {} }],
    ['an event name that is an object', { event: { a: 1 }, payload: {} }],
    ['an empty event name', { event: '', payload: {} }],
    ['a JSON array', [1, 2, 3]],
    ['an event name that is not text but a long array', { event: Array.from({ length: 50 }, () => 'payment.captured') }],
  ])('hostile shape (%s) is a clean 400, nothing is written and nothing runs', async (_n, body) => {
    const res = await call(body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed webhook payload' });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  test('a JSON null body is a 400 too', async () => {
    const req = { headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': 'evt_null' }, rawBody: Buffer.from('null'), body: null };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await razorpay(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('well-formed events are untouched by the check: unknown event names and full payloads still pass', async () => {
    expect((await call({ event: 'something.new', payload: {} })).body).toEqual({ status: 'ok' });
    expect((await call({ event: 'transfer.settled', payload: {} })).statusCode).toBe(200);
    expect(prisma.webhookEvent.create).toHaveBeenCalled();
  });

  test('a signed event that fails while processing is still a 500 so Razorpay retries it', async () => {
    prisma.escrowTransaction.findUnique.mockRejectedValue(new Error('db down'));
    expect((await call(captured())).statusCode).toBe(500);
  });
});

describe('payment.failed', () => {
  const failed = { event: 'payment.failed', payload: { payment: { entity: { order_id: 'order_1' } } } };

  test('OUT OF ORDER: a stale failure for an escrow that is already held does not touch it', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'HELD' });
    await call(failed);
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a pending escrow only remembers the attempt (stays open for a retry) and tells the buyer', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'PAYMENT_PENDING', buyerId: 'b1', leadId: 'l1' });
    prisma.user.findUnique.mockResolvedValue({ email: 'b@x.in' });
    await call(failed);
    const data = prisma.escrowTransaction.update.mock.calls[0][0].data;
    expect(data).toEqual({ failedAt: expect.any(Date) });
    expect(data.status).toBeUndefined();
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'b1', type: 'PAYMENT_FAILED' }));
  });

  test('a failed subscription payment is marked FAILED', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    prisma.userSubscription.findUnique.mockResolvedValue({ id: 's1', userId: 'u1' });
    await call(failed);
    expect(prisma.userSubscription.update).toHaveBeenCalledWith({ where: { razorpayOrderId: 'order_1' }, data: { paymentStatus: 'FAILED' } });
  });
});

describe('refund.created', () => {
  const refund = (amount, id = 'rfnd_1') => ({ event: 'refund.created', payload: { refund: { entity: { payment_id: 'pay_1', id, amount } } } });
  const held = (extra = {}) => ({ id: 'e1', status: 'HELD', amount: 1000, buyerId: 'b1', leadId: 'l1', refundIds: [], refundedAmountPaise: 0, ...extra });
  beforeEach(() => { prisma.userSubscription.findFirst.mockResolvedValue(null); });

  test('a full refund of a held escrow makes it REFUNDED', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held());
    await call(refund(100000));
    // One guarded write (audit Nov 2026, F5): only while the row is as it was read and this refund id is not on it yet.
    const w = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(w.where).toEqual({ id: 'e1', status: 'HELD', NOT: { refundIds: { has: 'rfnd_1' } } });
    expect(w.data).toMatchObject({ status: 'REFUNDED', refundedAmountPaise: { increment: 100000 }, refundIds: { push: 'rfnd_1' } });
    // and the ledger hears of a refund made in the Razorpay dashboard
    expect(ledger.onRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), expect.objectContaining({ refundPaise: 100000, reason: 'RAZORPAY_DASHBOARD' }), expect.objectContaining({ refundId: 'rfnd_1' }));
  });

  test('RACE: when the row changed between the read and the write, nothing is counted and Razorpay is asked to send it again', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call(refund(100000));
    expect(res.statusCode).toBe(500);
    expect(ledger.onRefund).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('the app\'s own refund still being written (REFUNDED, no refund id yet) is not reported as an unexpected refund', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held({ status: 'REFUNDED' }));
    await call(refund(100000));
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(broadcastNotification).not.toHaveBeenCalled();
  });

  test('a partial refund is PARTIALLY_REFUNDED and the amounts add up across refunds', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 40000, refundIds: ['rfnd_0'] }));
    await call(refund(30000));
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: { increment: 30000 } });
    // two part refunds landing together: the status is settled again from the stored total
    expect(prisma.escrowTransaction.updateMany.mock.calls[1][0]).toEqual({ where: { id: 'e1', status: 'PARTIALLY_REFUNDED', refundedAmountPaise: { gte: 100000 } }, data: { status: 'REFUNDED', refundedAt: expect.any(Date) } });
    prisma.escrowTransaction.updateMany.mockClear();
    prisma.escrowTransaction.findFirst.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 70000, refundIds: ['rfnd_0', 'rfnd_1'] }));
    await call(refund(30000, 'rfnd_2'));
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data.status).toBe('REFUNDED');
  });

  test('REPLAY: the same refund id twice is counted once', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held({ refundIds: ['rfnd_1'], refundedAmountPaise: 100000, status: 'PARTIALLY_REFUNDED' }));
    await call(refund(100000));
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
  });

  test.each(['RELEASED', 'HELD_PAYOUT_FAILED', 'PAYMENT_PENDING', 'REFUNDED'])('a refund on a %s escrow does not change its status and alerts the admins', async (status) => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(held({ status, ...(status === 'REFUNDED' ? { razorpayRefundId: 'rfnd_0', refundIds: ['rfnd_0'] } : {}) }));
    await call(refund(100000));
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(broadcastNotification).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['adm1'], type: 'ESCROW_PAYOUT_FAILED' }));
  });

  test('a refund for a payment we never recorded changes nothing', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    expect((await call(refund(100))).body).toEqual({ status: 'ok' });
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
  });

  test('a subscription refund: partial stays unrefunded, full marks REFUNDED, a repeat is ignored', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    prisma.userSubscription.findFirst.mockResolvedValue({ id: 's1', userId: 'u1', amountPaid: 500, refundIds: [], refundedAmountPaise: 0, paymentStatus: 'PAID' });
    await call(refund(20000));
    expect(prisma.userSubscription.update.mock.calls[0][0].data.paymentStatus).toBeUndefined();
    prisma.userSubscription.update.mockClear();
    await call(refund(50000, 'rfnd_9'));
    expect(prisma.userSubscription.update.mock.calls[0][0].data.paymentStatus).toBe('REFUNDED');
    prisma.userSubscription.update.mockClear();
    prisma.userSubscription.findFirst.mockResolvedValue({ id: 's1', userId: 'u1', amountPaid: 500, refundIds: ['rfnd_9'], refundedAmountPaise: 50000, paymentStatus: 'REFUNDED' });
    await call(refund(50000, 'rfnd_9'));
    expect(prisma.userSubscription.update).not.toHaveBeenCalled();
  });
});

describe('payouts', () => {
  const processed = { event: 'payout.processed', payload: { payout: { entity: { id: 'pout_p', utr: 'UTR1', amount: 100000 } } } };

  test('the partner payout is recorded, the ledger told, and the partner notified once', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', razorpayPayoutId: 'pout_s', razorpayPartnerPayoutId: 'pout_p', partnerPayoutStatus: 'queued', leadId: 'l1' });
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'p1', refCode: 'RD-L-1' });
    await call(processed);
    expect(prisma.escrowTransaction.update.mock.calls[0][0].data).toEqual({ partnerPayoutStatus: 'processed', partnerPayoutUtr: 'UTR1' });
    expect(ledger.onPayoutStatus).toHaveBeenCalledWith({ escrowId: 'e1', payoutId: 'pout_p', status: 'processed', utr: 'UTR1' });
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  test('REPLAY: a payout already processed is not announced to the partner again', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', razorpayPayoutId: 'pout_s', razorpayPartnerPayoutId: 'pout_p', partnerPayoutStatus: 'processed', leadId: 'l1' });
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'p1', refCode: 'RD-L-1' });
    await call(processed);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('the seller payout is recorded and nobody is notified (the seller is not necessarily a user)', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', razorpayPayoutId: 'pout_p', razorpayPartnerPayoutId: 'other', sellerPayoutStatus: 'queued' });
    await call(processed);
    expect(prisma.escrowTransaction.update.mock.calls[0][0].data).toEqual({ sellerPayoutStatus: 'processed', sellerPayoutUtr: 'UTR1' });
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('an unknown payout id changes nothing', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    expect((await call(processed)).body).toEqual({ status: 'ok' });
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
  });

  // Audit Nov 2026, F1: the create call got no answer, so we hold no payout id; the event carries our reference id.
  describe('a payout we have no id for, matched by its reference id', () => {
    const { adoptPayout } = require('../../src/modules/escrow/escrowPayout.service');
    const ESC = 'a'.repeat(24);
    const byRef = (ref) => ({ event: 'payout.processed', payload: { payout: { entity: { id: 'pout_x', utr: 'UTR9', amount: 4900000, reference_id: ref } } } });
    const row = (extra = {}) => ({ id: ESC, status: 'HELD_PAYOUT_FAILED', sellerPayoutStatus: 'unconfirmed', payoutAttempt: 2, leadId: 'l1', ...extra });

    test('is adopted when the leg is unconfirmed and the attempt number matches, then settled as usual', async () => {
      prisma.escrowTransaction.findFirst.mockResolvedValue(null);
      prisma.escrowTransaction.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ status: 'RELEASED', razorpayPayoutId: 'pout_x', sellerPayoutStatus: 'processing' }));
      await call(byRef(`esc_s_${ESC}_a2`));
      expect(adoptPayout).toHaveBeenCalledWith(expect.objectContaining({ id: ESC }), 'seller', expect.objectContaining({ id: 'pout_x', status: 'processing' }), 'webhook');
      expect(prisma.escrowTransaction.update.mock.calls[0][0].data).toEqual({ sellerPayoutStatus: 'processed', sellerPayoutUtr: 'UTR9' });
    });

    test.each([
      ['an older attempt', row(), `esc_s_${ESC}_a1`],
      ['a leg that is not unconfirmed', row({ sellerPayoutStatus: 'failed' }), `esc_s_${ESC}_a2`],
      ['an escrow that is not payout-failed', row({ status: 'HELD' }), `esc_s_${ESC}_a2`],
      ['a reference that is not ours', row(), 'something_else'],
    ])('is not adopted for %s', async (_n, r, ref) => {
      prisma.escrowTransaction.findFirst.mockResolvedValue(null);
      prisma.escrowTransaction.findUnique.mockResolvedValue(r);
      expect((await call(byRef(ref))).body).toEqual({ status: 'ok' });
      expect(adoptPayout).not.toHaveBeenCalled();
      expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
    });
  });

  const failure = (event, status = 'failed') => ({ event, payload: { payout: { entity: { id: 'pout_s', status, status_details: { description: 'bank said no' } } } } });

  test.each([['payout.failed', 'failed'], ['payout.rejected', 'rejected'], ['payout.reversed', 'reversed']])('%s flags a released escrow for manual review', async (event, status) => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', status: 'RELEASED', amount: 50000, razorpayPayoutId: 'pout_s', adminNote: 'earlier' });
    await call(failure(event, status));
    const data = prisma.escrowTransaction.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'HELD_PAYOUT_FAILED', sellerPayoutStatus: status, sellerPayoutFailureReason: 'bank said no' });
    expect(data.adminNote).toContain('earlier | seller payout');
    expect(broadcastNotification).toHaveBeenCalled();
    expect(ledger.onPayoutStatus).toHaveBeenCalled();
  });

  test('REPLAY: the same failure for a leg already recorded as failed is not recorded or announced twice', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', status: 'HELD_PAYOUT_FAILED', amount: 1, razorpayPayoutId: 'pout_s', sellerPayoutStatus: 'failed' });
    await call(failure('payout.failed'));
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
    expect(broadcastNotification).not.toHaveBeenCalled();
  });

  test('a failure for an escrow that is not released (for example refunded) is ignored', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', status: 'REFUNDED', amount: 1, razorpayPayoutId: 'pout_s' });
    await call(failure('payout.failed'));
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
  });
});
