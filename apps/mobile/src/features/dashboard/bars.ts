import type { SummaryBucket, SummaryGranularity } from '@/lib/api';

/** Height of the chart area on the Dashboard board (px). */
export const CHART_HEIGHT = 150;
/** Smallest height of a non-zero bar, so tiny values stay visible. */
export const MIN_BAR_HEIGHT = 4;

/** Vietnamese weekday labels, indexed by `Date#getUTCDay()`. */
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const;

export type Bar = {
  key: string;
  label: string;
  revenue: number;
  expense: number;
  revenueHeight: number;
  expenseHeight: number;
  /** The newest bucket (today / this week / this month). */
  current: boolean;
};

/** `T2` … `CN` for a `YYYY-MM-DD` business date. */
export function weekdayLabel(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** Column label: weekday for day buckets, `dd/MM` for weeks, `Th<m>` for months. */
export function barLabel(
  bucket: Pick<SummaryBucket, 'start'>,
  granularity: SummaryGranularity,
): string {
  const { start } = bucket;
  if (granularity === 'day') return weekdayLabel(start);
  if (granularity === 'week') return `${start.slice(8)}/${start.slice(5, 7)}`;
  return `Th${Number(start.slice(5, 7))}`;
}

/** Scale summary buckets to bar heights; the tallest value fills `maxHeight`. */
export function buildBars(
  buckets: readonly SummaryBucket[],
  granularity: SummaryGranularity,
  maxHeight: number = CHART_HEIGHT,
): Bar[] {
  const peak = Math.max(0, ...buckets.flatMap((b) => [b.revenue, b.expenses]));
  const height = (value: number) =>
    value <= 0 || peak === 0
      ? 0
      : Math.max(MIN_BAR_HEIGHT, Math.round((value / peak) * maxHeight));
  return buckets.map((bucket, index) => ({
    key: bucket.start,
    label: barLabel(bucket, granularity),
    revenue: bucket.revenue,
    expense: bucket.expenses,
    revenueHeight: height(bucket.revenue),
    expenseHeight: height(bucket.expenses),
    current: index === buckets.length - 1,
  }));
}
