import {
  addDays,
  businessDate,
  daysBetween,
  endOfMonth,
  isDateString,
  startOfMonth,
  startOfWeek,
  subMonths,
} from './date';

test('businessDate uses Asia/Ho_Chi_Minh (UTC+7)', () => {
  expect(businessDate('2026-10-22T16:59:00Z')).toBe('2026-10-22');
  expect(businessDate('2026-10-22T17:00:00Z')).toBe('2026-10-23');
  expect(businessDate(new Date('2026-10-23T05:00:00Z'))).toBe('2026-10-23');
  expect(businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('isDateString accepts only real calendar dates', () => {
  expect(isDateString('2026-02-28')).toBe(true);
  expect(isDateString('2026-02-30')).toBe(false);
  expect(isDateString('2026-13-01')).toBe(false);
  expect(isDateString('26-1-1')).toBe(false);
});

test('addDays and daysBetween cross month and year ends', () => {
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  expect(daysBetween('2026-10-01', '2026-10-23')).toBe(22);
  expect(daysBetween('2026-10-23', '2026-10-20')).toBe(-3);
});

test('week and month helpers', () => {
  expect(startOfWeek('2026-10-23')).toBe('2026-10-19'); // Friday -> Monday
  expect(startOfWeek('2026-10-25')).toBe('2026-10-19'); // Sunday -> Monday
  expect(startOfWeek('2026-10-19')).toBe('2026-10-19');
  expect(startOfMonth('2026-10-23')).toBe('2026-10-01');
  expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  expect(endOfMonth('2026-12-10')).toBe('2026-12-31');
  expect(subMonths('2026-02-10', 3)).toBe('2025-11-01');
});
