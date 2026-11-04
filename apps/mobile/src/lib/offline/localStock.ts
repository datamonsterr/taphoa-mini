import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { CreateSaleRequest, Page, Product } from '@/lib/api/types';

import { getCatalog, mapCachedProducts } from './catalog';
import { keys } from '@/lib/api/keys';
import type { CatalogSnapshot } from './catalog';

type SaleLines = Pick<CreateSaleRequest, 'lines'>;

/** Every product the device can see: the snapshot first, then the cached lists and details. */
function knownProducts(qc: QueryClient): Map<string, Product> {
  const out = new Map<string, Product>();
  for (const [, data] of qc.getQueriesData<
    Product | InfiniteData<Page<Product>>
  >({ queryKey: keys.products.all() })) {
    if (!data) continue;
    if ('pages' in data)
      for (const page of data.pages)
        for (const item of page.items) out.set(item.id, item);
    else out.set(data.id, data);
  }
  for (const [id, item] of Object.entries(getCatalog(qc).products))
    out.set(id, item);
  return out;
}

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
  const known = knownProducts(qc);
  const sold = new Map<string, number>();
  for (const line of sale.lines) {
    const id = line.product_id;
    if (!id || (only && !only.has(id))) continue;
    // A unit line (a pack, a crate) counts quantity_in_base base units each.
    const factor = line.unit_id
      ? (known.get(id)?.units.find((u) => u.id === line.unit_id)
          ?.quantity_in_base ?? 1)
      : 1;
    sold.set(id, (sold.get(id) ?? 0) + line.quantity * factor);
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
