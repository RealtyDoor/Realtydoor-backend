// BUG-053 follow-up: the Seller fees due list must show what the seller owes (fee + GST), not the platform's retained part (0 on a custom-rate deal).
const { feeDueAmounts } = require('../../src/modules/commission/commission.service');

describe('feeDueAmounts', () => {
  test('deal 2: 3.3% of Rs 78,00,000 is Rs 2,57,400, GST Rs 46,332, total Rs 3,03,732', () => {
    expect(feeDueAmounts({ dealPriceAtLock: 7800000, feePct: 3.3 }, 18)).toEqual({ feeDuePaise: 25740000, gstDuePaise: 4633200, amountDuePaise: 30373200 });
  });
  test('a standard 2% deal on Rs 75,00,000', () => {
    expect(feeDueAmounts({ dealPriceAtLock: 7500000, feePct: 2 }, 18)).toEqual({ feeDuePaise: 15000000, gstDuePaise: 2700000, amountDuePaise: 17700000 });
  });
  test('an older success-fee row without a price or percentage has no computed amount (the page falls back to its stored amount)', () => {
    expect(feeDueAmounts({ dealPriceAtLock: null, feePct: null }, 18)).toEqual({ feeDuePaise: null, gstDuePaise: null, amountDuePaise: null });
    expect(feeDueAmounts({ dealPriceAtLock: 7500000, feePct: 0 }, 18).amountDuePaise).toBeNull();
  });
});
