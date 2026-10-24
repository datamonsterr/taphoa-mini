import {
  closeDifference,
  countedFromDigits,
  dayMonth,
  MAX_CASH_DIGITS,
} from './difference';

test('difference is counted minus expected, with its status', () => {
  expect(closeDifference(740000, 740000)).toEqual({
    difference: 0,
    status: 'match',
  });
  expect(closeDifference(730000, 740000)).toEqual({
    difference: -10000,
    status: 'short',
  });
  expect(closeDifference(750000, 740000)).toEqual({
    difference: 10000,
    status: 'extra',
  });
});

test('countedFromDigits reads a digit string, empty is zero', () => {
  expect(countedFromDigits('')).toBe(0);
  expect(countedFromDigits('730000')).toBe(730000);
});

test('dayMonth shows dd/MM of a business date', () => {
  expect(dayMonth('2026-10-23')).toBe('23/10');
});

test('cash amounts are limited to 10 digits like the board', () => {
  expect(MAX_CASH_DIGITS).toBe(10);
});
