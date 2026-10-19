jest.mock('../../src/lib/prisma', () => ({}));
const { deliveryTracking } = require('../../src/modules/wati/wati.service');

describe('deliveryTracking (B131)', () => {
  test('no delivery callback ever seen -> null rate and NOT_CONFIGURED', () => {
    expect(deliveryTracking({ SENT: 81 })).toEqual({ deliveryPct: null, deliveryTracking: 'NOT_CONFIGURED' });
    expect(deliveryTracking({})).toEqual({ deliveryPct: null, deliveryTracking: 'NOT_CONFIGURED' });
  });
  test('callbacks arriving -> real rate', () => {
    expect(deliveryTracking({ SENT: 5, DELIVERED: 3, READ: 2 })).toEqual({ deliveryPct: 50, deliveryTracking: 'ENABLED' });
  });
});
