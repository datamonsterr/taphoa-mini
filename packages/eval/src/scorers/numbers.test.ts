import { describe, expect, it } from 'vitest';
import { extractNumbers, matchNumber } from './numbers.ts';

function only(text: string) {
  const items = extractNumbers(text);
  expect(items, `numbers in ${JSON.stringify(text)}`).toHaveLength(1);
  return items[0]!;
}

describe('extractNumbers: Vietnamese grouping', () => {
  it('reads a bare grouped number as an exact integer', () => {
    expect(only('1.234.000')).toEqual({
      value: 1234000,
      lo: 1234000,
      hi: 1234000,
      unit: null,
    });
  });

  it.each([
    '1.234.000 ₫',
    '1.234.000₫',
    '1.234.000đ',
    '1.234.000 đ',
    '1.234.000 đồng',
    '1.234.000 VND',
    '1.234.000 vnđ',
    'VND 1.234.000',
    '1.234.000 Đồng.',
  ])('reads %s as exact money', (text) => {
    expect(only(text)).toEqual({
      value: 1234000,
      lo: 1234000,
      hi: 1234000,
      unit: 'money',
    });
  });

  it('treats a dot plus exactly 3 digits as a thousands separator', () => {
    expect(only('1.500').value).toBe(1500);
    expect(only('12.000 đ').value).toBe(12000);
    expect(only('999.999').value).toBe(999999);
  });

  it('treats other dot forms as a decimal point', () => {
    expect(only('1.5').value).toBe(1.5);
    expect(only('12.50').value).toBe(12.5);
    expect(only('0.500').value).toBe(0.5);
  });

  it('reads a value that follows a sentence', () => {
    expect(only('Tổng doanh thu hôm qua: 1.234.000 ₫.').value).toBe(1234000);
  });

  it('accepts decomposed (NFD) Vietnamese letters', () => {
    expect(only('1.234.000 đồng'.normalize('NFD'))).toMatchObject({
      value: 1234000,
      unit: 'money',
    });
    expect(only('1,2 triệu'.normalize('NFD'))).toMatchObject({
      value: 1200000,
      unit: 'money',
    });
  });
});

describe('extractNumbers: decimal comma and percent', () => {
  it('reads one comma group of 1-2 digits as a decimal comma', () => {
    expect(only('1,5')).toEqual({ value: 1.5, lo: 1.5, hi: 1.5, unit: null });
    expect(only('12,25').value).toBe(12.25);
  });

  it('reads percentages with a decimal comma or point', () => {
    expect(only('12,5%')).toEqual({
      value: 12.5,
      lo: 12.5,
      hi: 12.5,
      unit: 'percent',
    });
    expect(only('12.5%')).toEqual({
      value: 12.5,
      lo: 12.5,
      hi: 12.5,
      unit: 'percent',
    });
    expect(only('Biên lợi nhuận 8 %')).toMatchObject({
      value: 8,
      unit: 'percent',
    });
  });

  it('reads mixed separators by their last separator', () => {
    expect(only('1.234,5').value).toBe(1234.5);
    expect(only('1,234.56').value).toBe(1234.56);
  });
});

describe('extractNumbers: word scales', () => {
  it('derives the range from the stated precision for decimals', () => {
    expect(only('1,2 triệu')).toEqual({
      value: 1200000,
      lo: 1150000,
      hi: 1250000,
      unit: 'money',
    });
    expect(only('1,2tr')).toEqual({
      value: 1200000,
      lo: 1150000,
      hi: 1250000,
      unit: 'money',
    });
  });

  it('derives the range from the unit digit for integers', () => {
    expect(only('2 tỷ')).toEqual({
      value: 2e9,
      lo: 1.5e9,
      hi: 2.5e9,
      unit: 'money',
    });
    expect(only('850k')).toEqual({
      value: 850000,
      lo: 849500,
      hi: 850500,
      unit: 'money',
    });
    expect(only('850 nghìn')).toEqual({
      value: 850000,
      lo: 849500,
      hi: 850500,
      unit: 'money',
    });
    expect(only('850 ngàn')).toEqual({
      value: 850000,
      lo: 849500,
      hi: 850500,
      unit: 'money',
    });
  });

  it('keeps a trailing money word as money', () => {
    expect(only('1,2 triệu đồng')).toMatchObject({
      value: 1200000,
      unit: 'money',
    });
    expect(only('850k ₫')).toMatchObject({ value: 850000, unit: 'money' });
  });

  it('combines a scale with a smaller scale', () => {
    expect(only('1 triệu 200 nghìn')).toEqual({
      value: 1200000,
      lo: 1199500,
      hi: 1200500,
      unit: 'money',
    });
    expect(only('2 tỷ 500 triệu đồng')).toMatchObject({
      value: 2.5e9,
      lo: 2.4995e9,
      hi: 2.5005e9,
    });
  });

  it('reads trailing digits after a scale as its decimals', () => {
    expect(only('1 triệu 2')).toEqual({
      value: 1200000,
      lo: 1150000,
      hi: 1250000,
      unit: 'money',
    });
    expect(only('Giá 1 triệu 2.')).toMatchObject({ value: 1200000 });
    expect(only('Giá 1tr2, lãi thấp')).toMatchObject({ value: 1200000 });
    expect(only('5k2')).toMatchObject({ value: 5200 });
    expect(only('1 triệu 200')).toMatchObject({
      value: 1200000,
      lo: 1199500,
      hi: 1200500,
    });
  });

  it('does not glue a following count onto a scale', () => {
    const items = extractNumbers('1 triệu 2 đơn');
    expect(items.map((n) => n.value)).toEqual([1e6, 2]);
    expect(items[1]!.unit).toBe('count');
  });

  it('accepts unaccented scale words', () => {
    expect(only('1,5 trieu')).toMatchObject({ value: 1500000, unit: 'money' });
    expect(only('850 nghin')).toMatchObject({ value: 850000 });
  });

  it('does not read kg or ml as a scale', () => {
    expect(only('5kg')).toMatchObject({ value: 5, unit: null });
    expect(only('330ml')).toMatchObject({ value: 330, unit: null });
    expect(only('1.5l')).toMatchObject({ value: 1.5, unit: null });
  });
});

describe('extractNumbers: English', () => {
  it('reads English thousands', () => {
    expect(only('1,234,000')).toEqual({
      value: 1234000,
      lo: 1234000,
      hi: 1234000,
      unit: null,
    });
    expect(only('1,234').value).toBe(1234);
  });

  it('reads a money prefix', () => {
    expect(only('VND 1,234,000')).toEqual({
      value: 1234000,
      lo: 1234000,
      hi: 1234000,
      unit: 'money',
    });
    expect(only('VND1,234,000')).toMatchObject({ value: 1234000 });
  });

  it('reads million and thousand', () => {
    expect(only('1.5 million')).toEqual({
      value: 1.5e6,
      lo: 1.45e6,
      hi: 1.55e6,
      unit: 'money',
    });
    expect(only('850 thousand')).toMatchObject({ value: 850000 });
  });
});

describe('extractNumbers: counts', () => {
  it('reads a number followed by a noun as a count', () => {
    expect(only('24 chai')).toEqual({
      value: 24,
      lo: 24,
      hi: 24,
      unit: 'count',
    });
    expect(only('3 sản phẩm')).toEqual({
      value: 3,
      lo: 3,
      hi: 3,
      unit: 'count',
    });
  });

  it('leaves a bare number with a null unit', () => {
    expect(only('24.')).toMatchObject({ value: 24, unit: null });
  });

  it('finds several numbers in one answer', () => {
    const items = extractNumbers(
      'Coca 24 chai (1.200.000 ₫), Pepsi 12 chai, lãi 8,5%.',
    );
    expect(items.map((n) => [n.value, n.unit])).toEqual([
      [24, 'count'],
      [1200000, 'money'],
      [12, 'count'],
      [8.5, 'percent'],
    ]);
  });

  it('reads negative numbers', () => {
    expect(only('tồn kho -3 chai')).toMatchObject({
      value: -3,
      lo: -3,
      hi: -3,
    });
    expect(only('-1.234.000 ₫').value).toBe(-1234000);
    expect(extractNumbers('từ 10-20 chai').map((n) => n.value)).toEqual([
      10, 20,
    ]);
  });
});

describe('extractNumbers: false positives', () => {
  it.each([
    '20/10',
    '2026-10-20',
    '20/10/2026',
    '20.10.2026',
    'tháng 10/2026',
    '2026-10',
    '17:00',
    'ngày 20/10 và 17:30',
  ])('does not read a date or time %s', (text) => {
    expect(extractNumbers(text)).toEqual([]);
  });

  it('keeps real numbers next to a date', () => {
    const items = extractNumbers('Ngày 20/10 bán được 24 chai.');
    expect(items.map((n) => n.value)).toEqual([24]);
  });

  it('skips codes glued to letters', () => {
    expect(extractNumbers('Vitamin B12 và mã SKU9')).toEqual([]);
  });

  it('returns nothing for text without digits', () => {
    expect(extractNumbers('Không có dữ liệu')).toEqual([]);
    expect(extractNumbers('')).toEqual([]);
  });
});

describe('matchNumber', () => {
  it('matches every Vietnamese form of one amount', () => {
    for (const text of [
      '1.234.000',
      '1.234.000 ₫',
      '1.234.000đ',
      '1.234.000 đ',
      '1.234.000 đồng',
      '1.234.000 VND',
      'VND 1,234,000',
      '1,234,000',
    ]) {
      expect(matchNumber(`Doanh thu ${text} hôm qua`, 1234000), text).toBe(
        true,
      );
    }
  });

  it('is exact within the default 0.5 % tolerance', () => {
    expect(matchNumber('1.234.000 ₫', 1234000)).toBe(true);
    expect(matchNumber('1.234.000 ₫', 1236000)).toBe(true);
    expect(matchNumber('1.234.000 ₫', 1250000)).toBe(false);
    expect(matchNumber('1.234.000 ₫', 1300000)).toBe(false);
  });

  it('honours an explicit tolerance', () => {
    expect(matchNumber('1.000.000 ₫', 1040000)).toBe(false);
    expect(matchNumber('1.000.000 ₫', 1040000, 5)).toBe(true);
    expect(matchNumber('1.000.000 ₫', 1000001, 0)).toBe(false);
    expect(matchNumber('1.000.000 ₫', 1000000, 0)).toBe(true);
  });

  it('matches inside the range of an approximate form', () => {
    expect(matchNumber('khoảng 1,2 triệu', 1200000)).toBe(true);
    expect(matchNumber('khoảng 1,2 triệu', 1180000)).toBe(true);
    expect(matchNumber('khoảng 1,2 triệu', 1249000)).toBe(true);
    expect(matchNumber('khoảng 1,2 triệu', 1100000)).toBe(false);
    expect(matchNumber('khoảng 1,2 triệu', 1300000)).toBe(false);
  });

  it('keeps the upper end of an approximate form exclusive at tolerance 0', () => {
    expect(matchNumber('1,2 triệu', 1250000, 0)).toBe(false);
    expect(matchNumber('1,2 triệu', 1150000, 0)).toBe(true);
  });

  it('matches word scales', () => {
    expect(matchNumber('Bán 850k', 850000)).toBe(true);
    expect(matchNumber('Bán 850 nghìn', 850000)).toBe(true);
    expect(matchNumber('Bán 850 ngàn', 850000)).toBe(true);
    expect(matchNumber('Bán 850 nghìn', 900000)).toBe(false);
    expect(matchNumber('Vốn 2 tỷ', 2000000000)).toBe(true);
    expect(matchNumber('Giá 1 triệu 200 nghìn', 1200000)).toBe(true);
    expect(matchNumber('Giá 1 triệu 200 nghìn', 1000000)).toBe(false);
    expect(matchNumber('Giá 1 triệu 2', 1200000)).toBe(true);
    expect(matchNumber('Sales 1.5 million', 1500000)).toBe(true);
  });

  it('matches percentages and counts', () => {
    expect(matchNumber('Lãi 12,5%', 12.5)).toBe(true);
    expect(matchNumber('Lãi 12.5%', 12.5)).toBe(true);
    expect(matchNumber('Lãi 12,5%', 13)).toBe(false);
    expect(matchNumber('Còn 24 chai', 24)).toBe(true);
    expect(matchNumber('Còn 24 chai', 25)).toBe(false);
    expect(matchNumber('3 sản phẩm', 3)).toBe(true);
  });

  it('matches negatives', () => {
    expect(matchNumber('tồn kho -3 chai', -3)).toBe(true);
    expect(matchNumber('tồn kho -3 chai', 3)).toBe(false);
  });

  it('does not take a date as a money value or a count', () => {
    expect(matchNumber('Hết hạn 20/10', 20)).toBe(false);
    expect(matchNumber('Hết hạn 20/10', 10)).toBe(false);
    expect(matchNumber('Ngày 2026-10-20', 2026)).toBe(false);
    expect(matchNumber('Ngày 2026-10-20', 20)).toBe(false);
    expect(matchNumber('Ngày 2026-10-20', 2026000)).toBe(false);
  });

  it('returns false when no number appears', () => {
    expect(matchNumber('Không có dữ liệu', 5)).toBe(false);
    expect(matchNumber('', 0)).toBe(false);
  });

  it('matches zero exactly', () => {
    expect(matchNumber('0 chai', 0)).toBe(true);
    expect(matchNumber('1 chai', 0)).toBe(false);
  });
});
