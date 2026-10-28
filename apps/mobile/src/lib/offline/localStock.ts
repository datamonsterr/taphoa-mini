import type { QueryClient } from '@tanstack/react-query';

import type { CreateSaleRequest } from '@/lib/api/types';

import { getCatalog, mapCachedProducts } from './catalog';
import { keys } from '@/lib/api/keys';
import type { CatalogSnapshot } from './catalog';

type SaleLines = Pick<CreateSaleRequest, 'lines'>;

/**
 * Optimistic stock: takes the sold quantities off the cached products (lists, details and the
 * catalog snapshot) the moment a sale is recorded. Untracked stock (null) stays null. The server
 * value replaces this after the sale replays and the products refetch.
 */
export function decrementLocalStock(
  qc: QueryClient,
  sale: SaleLines,
  /** Only these products (after a sync replaced them); all when omitted. */
  only?: ReadonlySet<string>,
) {
  const sold = new Map<string, number>();
  for (const line of sale.lines) {
    const id = line.product_id;
    if (!id || (only && !only.has(id))) continue;
    sold.set(id, (sold.get(id) ?? 0) + line.quantity);
  }
  const take = <T extends { id: string; stock_quantity: number | null }>(
    product: T,
  ): T => {
    const qty = sold.get(product.id);
    if (qty === undefined || product.stock_quantity === null) return product;
    const stock_quantity = product.stock_quantity - qty;
    return {
      ...product,
      stock_quantity,
      ...(stock_quantity <= 0 && 'stock_status' in product
        ? { stock_status: 'out' }
        : {}),
    };
  };
  mapCachedProducts(qc, take);
  const snapshot = getCatalog(qc);
  if (Object.keys(snapshot.products).length > 0) {
    const products = { ...snapshot.products };
    for (const id of sold.keys())
      if (products[id]) products[id] = take(products[id]);
    qc.setQueryData<CatalogSnapshot>(keys.catalog(), { ...snapshot, products });
  }
}
