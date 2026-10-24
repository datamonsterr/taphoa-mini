import type { SummaryBucket } from '@/lib/api';

import {
  barLabel,
  buildBars,
  CHART_HEIGHT,
  MIN_BAR_HEIGHT,
  weekdayLabel,
} from './bars';

const bucket = (
  start: string,
  revenue: number,
  expenses: number,
  end = start,
): SummaryBucket => ({
  start,
  end,
  revenue,
  expenses,
  net: revenue - expenses,
  sales_count: 1,
});

test('weekdayLabel names days T2 to CN', () => {
  // 2026-10-19 is a Monday
  expect(
    [19, 20, 21, 22, 23, 24, 25].map((d) => weekdayLabel(`2026-10-${d}`)),
  ).toEqual(['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']);
});

test('barLabel: weekday per day, dd/MM per week, Th<m> per month', () => {
  expect(barLabel(bucket('2026-10-25', 0, 0), 'day')).toBe('CN');
  expect(barLabel(bucket('2026-10-19', 0, 0, '2026-10-25'), 'week')).toBe(
    '19/10',
  );
  expect(barLabel(bucket('2026-05-01', 0, 0, '2026-05-31'), 'month')).toBe(
    'Th5',
  );
});

test('heights scale to the tallest value across revenue and expense', () => {
  const bars = buildBars(
    [bucket('2026-10-19', 1000, 250), bucket('2026-10-20', 500, 1000)],
    'day',
  );
  expect(bars.map((b) => [b.revenueHeight, b.expenseHeight])).toEqual([
    [CHART_HEIGHT, 38],
    [75, CHART_HEIGHT],
  ]);
});

test('custom chart height, zero stays zero, non-zero gets a minimum', () => {
  const bars = buildBars(
    [bucket('2026-10-19', 100000, 0), bucket('2026-10-20', 1, 0)],
    'day',
    100,
  );
  expect(bars[0]).toMatchObject({ revenueHeight: 100, expenseHeight: 0 });
  expect(bars[1]!.revenueHeight).toBe(MIN_BAR_HEIGHT);
});

test('all-zero data gives flat bars', () => {
  const bars = buildBars([bucket('2026-10-19', 0, 0)], 'day');
  expect(bars[0]).toMatchObject({ revenueHeight: 0, expenseHeight: 0 });
});

test('keeps values, labels and marks only the last bar as current', () => {
  const bars = buildBars(
    [bucket('2026-10-24', 10, 2), bucket('2026-10-25', 20, 4)],
    'day',
  );
  expect(
    bars.map((b) => [b.key, b.label, b.revenue, b.expense, b.current]),
  ).toEqual([
    ['2026-10-24', 'T7', 10, 2, false],
    ['2026-10-25', 'CN', 20, 4, true],
  ]);
});

test('no buckets, no bars', () => {
  expect(buildBars([], 'day')).toEqual([]);
});
