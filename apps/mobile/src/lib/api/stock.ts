import { newUuid } from '@/lib/uuid';

import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Page, StockItem, StockMovement, StockAdjustment } from './types';

export type StockStatus = 'all' | 'low' | 'out';
export type CursorParams = { cursor?: string | null; limit?: number };
export const cursorQuery = ({ cursor, ...params }: CursorParams) => ({
  ...params,
  ...(cursor ? { cursor } : {}),
});

export const listStock = (
  params: CursorParams & { status?: StockStatus } = {},
): Promise<Page<StockItem>> =>
  unwrap(
    getApiClient().raw.GET('/v1/stock', {
      params: { query: cursorQuery(params) },
    }),
  );

export const listStockMovements = (
  productId: string,
  params: CursorParams = {},
): Promise<Page<StockMovement>> =>
  unwrap(
    getApiClient().raw.GET('/v1/products/{productId}/stock-movements', {
      params: { path: { productId }, query: cursorQuery(params) },
    }),
  );

/** Pass the same key when retrying a logical adjustment. */
export const adjustStock = (
  productId: string,
  body: StockAdjustment,
  idempotencyKey = newUuid(),
): Promise<StockMovement> =>
  unwrap(
    getApiClient().raw.POST('/v1/products/{productId}/stock-adjustments', {
      params: {
        path: { productId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }),
  );
