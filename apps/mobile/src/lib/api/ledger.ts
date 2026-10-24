import { getApiClient } from './client';
import { unwrap } from './errors';
import type {
  AlertStatus,
  CreateExpenseRequest,
  CreateSaleRequest,
  DailyReport,
  DayClose,
  Expense,
  ExpenseCategory,
  MarginAlert,
  Page,
  PaymentMethod,
  Sale,
  SummaryGranularity,
  SummaryReport,
} from './types';

type DateRange = { from?: string; to?: string };
type PageParams = { limit?: number; cursor?: string | null };

const cursorQuery = ({ cursor, ...rest }: PageParams) => ({
  ...rest,
  ...(cursor ? { cursor } : {}),
});

/** The sale `id` is the idempotency key: a replay of the same id and body answers 200 with the stored sale. */
export const createSale = (body: CreateSaleRequest): Promise<Sale> =>
  unwrap(
    getApiClient().raw.POST('/v1/sales', {
      body,
      headers: { 'Idempotency-Key': body.id },
    }),
  );

export function listSales(
  params: DateRange &
    PageParams & {
      member_id?: string;
      payment_method?: PaymentMethod;
      status?: 'completed' | 'voided';
    } = {},
): Promise<Page<Sale>> {
  return unwrap(
    getApiClient().raw.GET('/v1/sales', {
      params: { query: cursorQuery(params) },
    }),
  );
}

export const createExpense = (body: CreateExpenseRequest): Promise<Expense> =>
  unwrap(getApiClient().raw.POST('/v1/expenses', { body }));

export function listExpenses(
  params: DateRange & PageParams & { category?: ExpenseCategory } = {},
): Promise<Page<Expense>> {
  return unwrap(
    getApiClient().raw.GET('/v1/expenses', {
      params: { query: cursorQuery(params) },
    }),
  );
}

export const listAlerts = async (
  status: AlertStatus = 'open',
): Promise<MarginAlert[]> =>
  (
    await unwrap(
      getApiClient().raw.GET('/v1/alerts', { params: { query: { status } } }),
    )
  ).items;

export const acceptAlert = (
  alertId: string,
  newPrice?: number,
): Promise<MarginAlert> =>
  unwrap(
    getApiClient().raw.POST('/v1/alerts/{alertId}/accept', {
      params: { path: { alertId } },
      body: newPrice === undefined ? {} : { new_price: newPrice },
    }),
  );

export const dismissAlert = (alertId: string): Promise<MarginAlert> =>
  unwrap(
    getApiClient().raw.POST('/v1/alerts/{alertId}/dismiss', {
      params: { path: { alertId } },
    }),
  );

export const getTodayReport = (date?: string): Promise<DailyReport> =>
  unwrap(
    getApiClient().raw.GET('/v1/reports/today', {
      params: { query: date ? { date } : {} },
    }),
  );

export const getReportSummary = (params: {
  from: string;
  to: string;
  granularity?: SummaryGranularity;
}): Promise<SummaryReport> =>
  unwrap(
    getApiClient().raw.GET('/v1/reports/summary', {
      params: { query: params },
    }),
  );

export const getDayClose = (businessDate: string): Promise<DayClose> =>
  unwrap(
    getApiClient().raw.GET('/v1/day-closes/{businessDate}', {
      params: { path: { businessDate } },
    }),
  );

export const createDayClose = (
  businessDate: string,
  body: { counted_cash: number; opening_float?: number; note?: string },
): Promise<DayClose> =>
  unwrap(
    getApiClient().raw.PUT('/v1/day-closes/{businessDate}', {
      params: { path: { businessDate } },
      body,
    }),
  );
