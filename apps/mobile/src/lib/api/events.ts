import type { QueryClient } from '@tanstack/react-query';

import { useLowStockAlerts, type LowStockAlert } from '@/stores/lowStockAlerts';

import { applyProductIndexed } from './hooks';
import { keys } from './keys';
import type { ProductIndexStatus, StockMovement } from './types';

type Payloads = {
  'product.indexed': {
    product_id: string;
    index_status: ProductIndexStatus;
    reference_count?: number;
  };
  'stock.changed': {
    product_id: string;
    stock_quantity: number;
    reason: StockMovement['reason'];
  };
  'stock.low': Omit<LowStockAlert, 'at'>;
  'receipt.confirmed': {
    receipt_id: string;
    expense_id: string;
    total: number;
    line_count: number;
  };
};

/** Typed payloads supplement StoreEvent.data (an empty object in the generated OpenAPI type). */
export type MobileStoreEvent = {
  [T in keyof Payloads]: { type: T; occurred_at: string; data: Payloads[T] };
}[keyof Payloads];

/** SSE event effects; transport owners pass the decoded event envelope here. */
export function applyStoreEvent(
  queryClient: QueryClient,
  event: MobileStoreEvent,
): void {
  switch (event.type) {
    case 'product.indexed':
      applyProductIndexed(queryClient, event.data);
      break;
    case 'stock.changed':
      for (const queryKey of [
        keys.stock.all(),
        keys.products.all(),
        keys.stockMovements(event.data.product_id),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      break;
    case 'stock.low':
      useLowStockAlerts
        .getState()
        .push({ ...event.data, at: event.occurred_at });
      break;
    case 'receipt.confirmed':
      void queryClient.invalidateQueries({ queryKey: keys.receipts.all() });
      break;
  }
}
