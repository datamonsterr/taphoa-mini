import { vndToWords } from './vndWords';

test.each([
  [0, 'không đồng'],
  [500, 'năm trăm đồng'],
  [1000, 'một nghìn đồng'],
  [4500, 'bốn nghìn năm trăm đồng'],
  [10000, 'mười nghìn đồng'],
  [15000, 'mười lăm nghìn đồng'],
  [21000, 'hai mươi mốt nghìn đồng'],
  [25000, 'hai mươi lăm nghìn đồng'],
  [105000, 'một trăm linh năm nghìn đồng'],
  [49500, 'bốn mươi chín nghìn năm trăm đồng'],
  [85000, 'tám mươi lăm nghìn đồng'],
  [1250000, 'một triệu hai trăm năm mươi nghìn đồng'],
  [1005000, 'một triệu không trăm linh năm nghìn đồng'],
  [2000000000, 'hai tỷ đồng'],
])('%i -> %s', (amount, words) => {
  expect(vndToWords(amount)).toBe(words);
});

test('negative and fractional amounts are clamped to whole đồng', () => {
  expect(vndToWords(-5)).toBe('không đồng');
  expect(vndToWords(1500.9)).toBe('một nghìn năm trăm đồng');
});
