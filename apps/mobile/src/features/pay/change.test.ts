import { CASH_NOTES, computeChange, quickCashOptions } from './change';

describe('computeChange', () => {
  it('returns tendered minus total', () => {
    expect(computeChange(49500, 100000)).toBe(50500);
  });

  it('is 0 for exact cash', () => {
    expect(computeChange(49500, 49500)).toBe(0);
  });

  it('never goes negative when tendered is short', () => {
    expect(computeChange(49500, 20000)).toBe(0);
  });
});

describe('quickCashOptions', () => {
  it('lists the four board notes only', () => {
    expect(quickCashOptions()).toEqual([50000, 100000, 200000, 500000]);
    expect(CASH_NOTES).toEqual([50000, 100000, 200000, 500000]);
  });
});
