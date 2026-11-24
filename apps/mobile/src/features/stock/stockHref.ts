import type { Href } from 'expo-router';

import type { StockStatus } from '@/lib/api/stock';

const STATUSES: readonly string[] = ['all', 'low', 'out', 'ok'];

export function parseStockStatus(value: unknown): StockStatus {
  return typeof value === 'string' && STATUSES.includes(value)
    ? (value as StockStatus)
    : 'all';
}

/** Canonical URL of the Kho tab's Tồn kho segment; `/stock` is only an alias of it. */
export function stockHref(status?: string): Href {
  return `/inventory?segment=stock&status=${parseStockStatus(status)}` as Href;
}
