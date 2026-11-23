import { onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useLowStockAlerts } from '@/stores/lowStockAlerts';

import { useLowStockItems } from './useLowStockItems';

/** Mount once in the shop layout. */
export function useLowStockWatcher() {
  const { low, out, items } = useLowStockItems();
  const reconcile = useLowStockAlerts((s) => s.reconcile);
  const { refetch: refetchLow } = low;
  const { refetch: refetchOut } = out;

  useEffect(() => {
    // Wait for both queries so a low -> out transition cannot look like recovery.
    if (!low.isSuccess || !out.isSuccess || low.isFetching || out.isFetching)
      return;
    reconcile(
      items.flatMap((item) =>
        item.stock_quantity === null
          ? []
          : [
              {
                product_id: item.product_id,
                name: item.name,
                stock_quantity: item.stock_quantity,
                threshold: item.low_stock_threshold,
                at: item.updated_at,
              },
            ],
      ),
      // Absence from a truncated page is not evidence of recovery.
      !low.hasNextPage && !out.hasNextPage,
    );
  }, [
    items,
    low.isSuccess,
    out.isSuccess,
    low.isFetching,
    out.isFetching,
    low.hasNextPage,
    out.hasNextPage,
    reconcile,
  ]);

  useEffect(() => {
    let state = AppState.currentState;
    const refetch = () => {
      void refetchLow();
      void refetchOut();
    };
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === state) return;
      state = next;
      if (next === 'active') refetch();
    });
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) refetch();
    });
    return () => {
      unsubscribe();
      subscription.remove();
    };
  }, [refetchLow, refetchOut]);
}
