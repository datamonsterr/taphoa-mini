import { useCallback, useMemo } from 'react';

import type { Period } from '@/components/ui';
import {
  summaryRange,
  useAllSales,
  useReportSummary,
  useTodayReport,
  type Sale,
} from '@/lib/api';
import { businessDate, startOfMonth, startOfWeek } from '@/lib/date';

import { buildBars, type Bar } from './bars';

export type DashboardTotals = {
  revenue: number;
  salesCount: number;
  cash: number;
  transfer: number;
  expense: number;
  net: number;
};

export type DashboardData =
  | { status: 'loading'; refetch: () => void }
  | { status: 'error'; refetch: () => void }
  | {
      status: 'ready';
      refetch: () => void;
      totals: DashboardTotals;
      bars: Bar[];
    };

/** Date range of the newest bucket: today, this week (from Monday) or this month. */
export function currentRange(period: Period, now?: Date) {
  const { to } = summaryRange(period, now);
  const from =
    period === 'day'
      ? to
      : period === 'week'
        ? startOfWeek(to)
        : startOfMonth(to);
  return { from, to };
}

/** Money actually paid by `method`: a credit sale's unpaid part is debt, not cash or transfer. */
const sumBy = (sales: readonly Sale[], method: Sale['payment_method']) =>
  sales
    .filter((sale) => sale.payment_method === method)
    .reduce((total, sale) => total + sale.total - sale.credit_amount, 0);

/**
 * Everything the report screen shows for a period. Day: today's report. Week and month: the
 * newest summary bucket, with the cash / transfer split summed from that range's sales
 * (the summary has no payment split; every page of sales is followed). Day mode needs no sales.
 * The business date keys the queries and the range memo, so they roll over after midnight.
 */
export function useDashboardData(period: Period): DashboardData {
  const date = businessDate();
  const isDay = period === 'day';
  const today = useTodayReport(date);
  const summary = useReportSummary(period, date);
  const range = useMemo(
    () => currentRange(period, new Date(date)),
    [period, date],
  );
  const sales = useAllSales({ ...range, status: 'completed' }, !isDay);
  const bucket = summary.data?.buckets.at(-1);

  const bars = useMemo(
    () => (summary.data ? buildBars(summary.data.buckets, period) : []),
    [summary.data, period],
  );

  const { refetch: refetchToday } = today;
  const { refetch: refetchSummary } = summary;
  const { refetch: refetchSales } = sales;
  const refetch = useCallback(() => {
    void refetchToday();
    void refetchSummary();
    void refetchSales();
  }, [refetchToday, refetchSummary, refetchSales]);

  const needed = isDay ? [today, summary] : [summary, sales];
  if (needed.some((query) => query.isError))
    return { status: 'error', refetch };
  if (needed.some((query) => query.isPending)) {
    return { status: 'loading', refetch };
  }

  const totals: DashboardTotals =
    isDay && today.data
      ? {
          revenue: today.data.revenue,
          salesCount: today.data.sales_count,
          cash: today.data.cash_revenue,
          transfer: today.data.transfer_revenue,
          expense: today.data.expenses,
          net: today.data.net,
        }
      : {
          revenue: bucket?.revenue ?? 0,
          salesCount: bucket?.sales_count ?? 0,
          cash: sumBy(sales.data ?? [], 'cash'),
          transfer: sumBy(sales.data ?? [], 'transfer'),
          expense: bucket?.expenses ?? 0,
          net: bucket?.net ?? 0,
        };
  return { status: 'ready', refetch, totals, bars };
}
