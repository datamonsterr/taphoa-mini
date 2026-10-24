import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { keys } from '@/lib/api/keys';
import type { Page, ProductWithStock } from '@/lib/api/types';

type Cached = ProductWithStock | InfiniteData<Page<ProductWithStock>>;

const withPrice = (id: string, price: number) => (old: Cached | undefined) => {
  if (!old) return old;
  if ('pages' in old) {
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        items: page.items.map((item) =>
          item.id === id ? { ...item, price } : item,
        ),
      })),
    };
  }
  return old.id === id ? { ...old, price } : old;
};

/**
 * Writes `price` into the cached product detail and every cached product list.
 * Returns a function that puts the previous cache values back.
 */
export async function applyOptimisticPrice(
  qc: QueryClient,
  id: string,
  price: number,
): Promise<() => void> {
  await qc.cancelQueries({ queryKey: keys.products.all() });
  const snapshot = qc.getQueriesData<Cached>({
    queryKey: keys.products.all(),
  });
  qc.setQueriesData<Cached>(
    { queryKey: keys.products.all() },
    withPrice(id, price),
  );
  return () => {
    for (const [key, data] of snapshot) qc.setQueryData(key, data);
  };
}
