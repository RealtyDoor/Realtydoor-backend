// 7 Nov 2026: the privacy spec and the template catalogue say money receipts and refunds are TRANSACTIONAL ("always sent, whatever the
// buyer's WhatsApp switch says"), but notifyUser sent every template as OPERATIONAL, so a buyer with WhatsApp turned off got no refund or
// receipt message. Money templates now go out whatever the switch says; everything else still respects it.
process.env.WATI_LIVE_TEMPLATES = 'escrow_token_received_v2,escrow_token_received,escrow_refunded_v2,escrow_refunded,escrow_released_v2,escrow_payment_failed_v2,buyer_ticket_update_v2,partner_token_held_v2,listing_approved_v2';
process.env.NODE_ENV = 'test';
delete process.env.WATI_ALLOWED_NUMBERS;
const mockPost = jest.fn();
jest.mock('axios', () => ({ create: () => ({ post: (...a) => mockPost(...a) }) }));
jest.mock('../../src/lib/prisma', () => ({
  user: { findUnique: jest.fn() },
  watiMessageLog: { create: jest.fn().mockResolvedValue({}) },
  watiTemplate: { findUnique: jest.fn().mockResolvedValue(null) },
}));
const prisma = require('../../src/lib/prisma');
const { notifyUser } = require('../../src/lib/wati');

beforeEach(() => {
  mockPost.mockReset(); mockPost.mockResolvedValue({ data: { messageId: 'm1' } });
  prisma.user.findUnique.mockReset();
  prisma.user.findUnique.mockResolvedValue({ name: 'Asha', phone: '+919999999999', notifWhatsapp: false, marketingOptIn: false });
});

describe.each(['escrow_token_received', 'escrow_refunded', 'escrow_released', 'escrow_payment_failed'])('%s with the buyer\'s WhatsApp switch off', (tpl) => {
  test('is still sent', async () => {
    await notifyUser('u1', tpl, { name: '$userName' }, {});
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].template_name).toMatch(new RegExp(`^${tpl}`));
  });
});

describe.each(['buyer_ticket_update', 'partner_token_held', 'listing_approved'])('%s with the switch off', (tpl) => {
  test('is not sent (operational messages respect the switch)', async () => {
    await notifyUser('u1', tpl, { name: '$userName' }, {});
    expect(mockPost).not.toHaveBeenCalled();
  });
});

test('operational messages are sent when the switch is on', async () => {
  prisma.user.findUnique.mockResolvedValue({ name: 'Asha', phone: '+919999999999', notifWhatsapp: true });
  await notifyUser('u1', 'buyer_ticket_update', { name: '$userName' }, {});
  expect(mockPost).toHaveBeenCalledTimes(1);
});
