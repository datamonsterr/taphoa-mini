import { addDays, endOfMonth, subMonths } from '@/lib/date';

import type { SummaryBucket, SummaryGranularity, SummaryReport } from './types';

type Range = { from: string; to: string; granularity: SummaryGranularity };

const nextMonth = (date: string) => subMonths(date, -1);

/** First day of every bucket in the range, oldest first. `from` is a day, a Monday or a 1st. */
function bucketStarts({ from, to, granularity }: Range): string[] {
  const starts: string[] = [];
  const step = (date: string) =>
    granularity === 'day'
      ? addDays(date, 1)
      : granularity === 'week'
        ? addDays(date, 7)
        : nextMonth(date);
  for (let start = from; start <= to; start = step(start)) starts.push(start);
  return starts;
}

function bucketEnd(start: string, to: string, granularity: SummaryGranularity) {
  const end =
    granularity === 'day'
      ? start
      : granularity === 'week'
        ? addDays(start, 6)
        : endOfMonth(start);
  return end < to ? end : to;
}

/**
 * The server lists only the buckets that have sales or expenses. The chart and the totals need
 * one bucket per day, week or month of the range, the newest being today, this week or this
 * month, even when it is empty: without the filler a quiet week would show last week's figures
 * as "this week".
 */
export function fillSummaryBuckets(
  report: SummaryReport,
  range: Range,
): SummaryReport {
  const byStart = new Map(report.buckets.map((b) => [b.start, b]));
  const buckets: SummaryBucket[] = bucketStarts(range).map(
    (start) =>
      byStart.get(start) ?? {
        start,
        end: bucketEnd(start, range.to, range.granularity),
        revenue: 0,
        expenses: 0,
        net: 0,
        sales_count: 0,
      },
  );
  return { ...report, buckets };
}
