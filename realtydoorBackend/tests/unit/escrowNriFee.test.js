// NRI processing fee (7 Nov 2026, owner's decision): an NRI buyer may pay with a foreign card, which Razorpay charges 3% + GST (3.54%) instead of
// 2% + GST (2.36%). So the processing fee is sized with the NRI rate for a buyer marked NRI and the normal rate for everyone else, and we net the
// full token either way. The buyer's own NRI flag decides, read from the database, never from anything the browser sends.
jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn() }, user: { findUnique: jest.fn() }, escrowTransaction: { findFirst: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: {}, createEscrowOrder: jest.fn(), refundPayment: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({}));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({}));

const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const { parseSettings } = jest.requireActual('../../src/modules/money/moneyConfig');
const svc = require('../../src/modules/escrow/escrow.service');

const TOKEN = 5_000_000; // ₹50,000 in paise
const netAfterFee = (total, pct) => total - (total * pct * 1.18) / 100;

beforeEach(() => { jest.resetAllMocks(); getMoneySettings.mockResolvedValue(parseSettings([])); });

describe('settings', () => {
  test('the NRI gateway rate defaults to 3%', () => {
    expect(parseSettings([]).processingFee.gatewayPctNri).toBe(3);
  });
});

describe('checkoutBreakdown', () => {
  test('a normal buyer: 2% + GST, total ₹51,209, gateway pct 2', () => {
    const b = svc.checkoutBreakdown(TOKEN, parseSettings([]));
    expect(b).toMatchObject({ totalPaise: 5_120_900, gatewayPct: 2, nri: false });
  });
  test('an NRI buyer: 3% + GST, we net the whole token', () => {
    const b = svc.checkoutBreakdown(TOKEN, parseSettings([]), { nri: true });
    expect(b).toMatchObject({ gatewayPct: 3, nri: true });
    expect(b.totalPaise).toBeGreaterThan(5_120_900);
    expect(netAfterFee(b.totalPaise, 3)).toBeGreaterThanOrEqual(TOKEN - 1);
  });
  test('the rate is read from settings, so the owner can change it', () => {
    const s = parseSettings([{ key: 'processing_fee_gateway_pct_nri', value: '4' }]);
    expect(svc.checkoutBreakdown(TOKEN, s, { nri: true }).gatewayPct).toBe(4);
  });
  test('turning the processing fee off charges nobody extra, NRI or not', () => {
    const s = parseSettings([{ key: 'processing_fee_enabled', value: 'false' }]);
    expect(svc.checkoutBreakdown(TOKEN, s, { nri: true }).totalPaise).toBe(TOKEN);
  });
});

describe('getCheckoutQuote', () => {
  test('passes the NRI flag through', async () => {
    expect((await svc.getCheckoutQuote(50000, { nri: true })).gatewayPct).toBe(3);
    expect((await svc.getCheckoutQuote(50000)).gatewayPct).toBe(2);
  });
});
