import { useMemo } from 'react';

import { useStock } from '@/lib/api/hooks';

/** The API's low filter excludes out; keep both groups in the same recovery snapshot. */
export function useLowStockItems() {
  const low = useStock('low');
  const out = useStock('out');
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
