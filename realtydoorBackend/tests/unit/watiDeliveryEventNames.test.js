// The delivery callbacks WATI offers on its webhook screen must be understood, so the delivery log can show delivered and read.
jest.mock('../../src/lib/prisma', () => ({}));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/modules/wati/wati.service', () => ({ recordDeliveryEvent: jest.fn().mockResolvedValue() }));
const { watiWebhook, DELIVERY_EVENTS } = require('../../src/modules/webhooks/wati.handler');
const { recordDeliveryEvent } = require('../../src/modules/wati/wati.service');

const call = async (body) => {
  process.env.WATI_WEBHOOK_TOKEN = 't'.repeat(20);
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  await watiWebhook({ headers: { 'x-wati-token': 't'.repeat(20) }, body, query: {} }, res);
  return res;
};

test.each([
  ['sentMessageDELIVERED_v2', 'DELIVERED'], ['sentMessageDELIVERED', 'DELIVERED'],
  ['sentMessageREAD_v2', 'READ'], ['sentMessageREAD', 'READ'],
  ['templateMessageFailed', 'FAILED'], ['templateMessageSent', 'SENT'],
])('%s is recorded as %s', async (eventType, status) => {
  const res = await call({ eventType, waId: '917760698948', id: 'm1' });
  expect(recordDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({ status, phone: '+917760698948' }));
  expect(res.json).toHaveBeenCalledWith({ status: 'ok', recorded: status });
});

test('the older names still work', () => {
  expect(DELIVERY_EVENTS.delivered).toBe('DELIVERED');
  expect(DELIVERY_EVENTS.messageRead).toBe('READ');
});
