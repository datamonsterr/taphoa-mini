import { summaryRange } from './hooks';
import { fillSummaryBuckets } from './summary';
import type { SummaryBucket, SummaryReport } from './types';

const bucket = (
  start: string,
  end: string,
  revenue: number,
): SummaryBucket => ({
  start,
  end,
  revenue,
  expenses: 0,
  net: revenue,
  sales_count: revenue > 0 ? 1 : 0,
});

// Saturday 2026-10-24 in Asia/Ho_Chi_Minh
const NOW = new Date('2026-10-24T03:00:00Z');

describe('fillSummaryBuckets', () => {
  it('adds the days the server left out, newest last', () => {
    const range = summaryRange('day', NOW);
    const report: SummaryReport = {
      granularity: 'day',
      buckets: [bucket('2026-10-20', '2026-10-20', 5000)],
    };
    const filled = fillSummaryBuckets(report, range);
    expect(filled.buckets.map((b) => b.start)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(filled.buckets[2]!.revenue).toBe(5000);
    expect(filled.buckets.at(-1)).toMatchObject({
      start: '2026-10-24',
      end: '2026-10-24',
      revenue: 0,
      sales_count: 0,
    });
  });

  it('a quiet current week is an empty bucket, not last week', () => {
    const range = summaryRange('week', NOW);
    const report: SummaryReport = {
      granularity: 'week',
      buckets: [bucket('2026-10-12', '2026-10-18', 90_000)],
    };
    const filled = fillSummaryBuckets(report, range);
    expect(filled.buckets).toHaveLength(6);
    expect(filled.buckets.at(-1)).toMatchObject({
      start: '2026-10-19',
      end: '2026-10-24',
      revenue: 0,
    });
    expect(filled.buckets.at(-2)!.revenue).toBe(90_000);
  });

  it('months run from the first of the month five months back to this month', () => {
    const range = summaryRange('month', NOW);
    const filled = fillSummaryBuckets(
      {
        granularity: 'month',
        buckets: [bucket('2026-08-01', '2026-08-31', 1)],
      },
      range,
    );
    expect(filled.buckets.map((b) => b.start)).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
    expect(filled.buckets.at(-1)).toMatchObject({
      end: '2026-10-24',
      revenue: 0,
    });
    expect(filled.buckets[1]).toMatchObject({ end: '2026-06-30' });
  });

  it('keeps a complete answer as it is', () => {
    const range = summaryRange('day', NOW);
    const full: SummaryReport = {
      granularity: 'day',
      buckets: ['18', '19', '20', '21', '22', '23', '24'].map((d, i) =>
        bucket(`2026-10-${d}`, `2026-10-${d}`, i * 100),
      ),
    };
    expect(fillSummaryBuckets(full, range)).toEqual(full);
  });
});
