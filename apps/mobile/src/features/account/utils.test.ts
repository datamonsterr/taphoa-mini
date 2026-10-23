import {
  formatAccountNumber,
  formatExpiry,
  formatToken,
  initialOf,
  stripDiacritics,
} from './utils';

test('initialOf takes the first letter of the last word', () => {
  expect(initialOf('Tạp hóa Cô Lan')).toBe('L');
  expect(initialOf('Đức')).toBe('Đ');
  expect(initialOf('  ')).toBe('?');
});

test('formatAccountNumber groups 4-3-3', () => {
  expect(formatAccountNumber('0123456789')).toBe('0123 456 789');
  expect(formatAccountNumber('0123')).toBe('0123');
});

test('formatToken groups by four', () => {
  expect(formatToken('K7Q4MZ2P9HXDT3VA')).toBe('K7Q4 MZ2P 9HXD T3VA');
});

test('formatExpiry renders HH:mm in Vietnam time', () => {
  expect(formatExpiry('2026-10-23T03:05:00.000Z')).toBe('10:05');
});

test('stripDiacritics uppercases and drops marks', () => {
  expect(stripDiacritics('Nguyễn Thị Đào')).toBe('NGUYEN THI DAO');
});
