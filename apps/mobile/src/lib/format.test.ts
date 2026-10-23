import { formatVnd, parseVnd } from './format';

describe('formatVnd', () => {
  test.each([
    [0, '0đ'],
    [500, '500đ'],
    [12000, '12.000đ'],
    [49500, '49.500đ'],
    [1234567, '1.234.567đ'],
    [-4500, '-4.500đ'],
    [1999.6, '2.000đ'],
  ])('%d -> %s', (input, expected) => {
    expect(formatVnd(input)).toBe(expected);
  });
});

describe('parseVnd', () => {
  test.each([
    ['12.000đ', 12000],
    ['12000', 12000],
    ['-4.500 đ', -4500],
    ['', 0],
    ['đ', 0],
  ])('%s -> %d', (input, expected) => {
    expect(parseVnd(input)).toBe(expected);
  });

  test('round trips', () => {
    expect(parseVnd(formatVnd(1234567))).toBe(1234567);
  });
});
