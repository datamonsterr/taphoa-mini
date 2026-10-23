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
  it('lists the exact amount first, then the board notes', () => {
    expect(quickCashOptions(49500)).toEqual([49500, ...CASH_NOTES]);
    expect(CASH_NOTES).toEqual([50000, 100000, 200000, 500000]);
  });

  it('drops a note equal to the total', () => {
    expect(quickCashOptions(100000)).toEqual([100000, 50000, 200000, 500000]);
  });

  it('returns only the notes when the total is 0', () => {
    expect(quickCashOptions(0)).toEqual([...CASH_NOTES]);
  });
});
