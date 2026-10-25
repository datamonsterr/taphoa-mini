import type { AlertStatus, ManualLineStatus, ReportPeriod } from './types';
import type { ListProductsParams } from './products';
import type { StockStatus } from './stock';
import type { ReceiptStatus } from './receipts';

/** React Query key factory. Every key starts with `api` so a whole mode can be reset at once. */
export const keys = {
  all: ['api'] as const,
  stock: {
    all: () => [...keys.all, 'stock'] as const,
    list: (status: StockStatus = 'all') =>
      [...keys.stock.all(), 'list', status] as const,
  },
  stockMovements: (id: string) => [...keys.all, 'stock-movements', id] as const,
  receipts: {
    all: () => [...keys.all, 'receipts'] as const,
    list: (status?: ReceiptStatus) =>
      [...keys.receipts.all(), 'list', status ?? null] as const,
    detail: (id: string) => [...keys.receipts.all(), 'detail', id] as const,
  },
  me: () => [...keys.all, 'me'] as const,
  store: () => [...keys.all, 'store'] as const,
  members: () => [...keys.all, 'members'] as const,
  categories: () => [...keys.all, 'categories'] as const,
  product: (id: string) => [...keys.all, 'products', 'detail', id] as const,
  products: {
    all: () => [...keys.all, 'products'] as const,
    list: (params: Omit<ListProductsParams, 'cursor'> = {}) =>
      [...keys.products.all(), 'list', params] as const,
    detail: (id: string) => [...keys.products.all(), 'detail', id] as const,
  },
  sales: {
    all: () => [...keys.all, 'sales'] as const,
    list: (params: object = {}) =>
      [...keys.sales.all(), 'list', params] as const,
    /** Every page of a range, fetched as one result. */
    every: (params: object = {}) =>
      [...keys.sales.all(), 'every', params] as const,
  },
  expenses: {
    all: () => [...keys.all, 'expenses'] as const,
    list: (params: object = {}) =>
      [...keys.expenses.all(), 'list', params] as const,
  },
  alerts: {
    all: () => [...keys.all, 'alerts'] as const,
    list: (status: AlertStatus = 'open') =>
      [...keys.alerts.all(), status] as const,
  },
  manualLines: {
    all: () => [...keys.all, 'manual-lines'] as const,
    list: (status: ManualLineStatus = 'open') =>
      [...keys.manualLines.all(), status] as const,
  },
  reports: {
    all: () => [...keys.all, 'reports'] as const,
    today: (date?: string) =>
      [...keys.reports.all(), 'today', date ?? null] as const,
    summary: (period: ReportPeriod, date?: string) =>
      [...keys.reports.all(), 'summary', period, date ?? null] as const,
    dayClose: (date: string) =>
      [...keys.reports.all(), 'day-close', date] as const,
  },
};
