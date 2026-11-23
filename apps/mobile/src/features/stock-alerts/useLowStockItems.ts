import { useMemo } from 'react';

import { useStock } from '@/lib/api/hooks';

/** Focus refreshes are bounded by this: no refetch while data is younger. */
export const LOW_STOCK_STALE_MS = 60_000;

/** The API's low filter excludes out; keep both groups in the same recovery snapshot. */
export function useLowStockItems() {
  const low = useStock('low', { staleTime: LOW_STOCK_STALE_MS });
  const out = useStock('out', { staleTime: LOW_STOCK_STALE_MS });
  const items = useMemo(
    () => [
      ...new Map(
        [...(out.data ?? []), ...(low.data ?? [])]
          .filter((item) => item.status === 'low' || item.status === 'out')
          .map((item) => [item.product_id, item]),
      ).values(),
    ],
    [low.data, out.data],
  );
  return { low, out, items };
}
