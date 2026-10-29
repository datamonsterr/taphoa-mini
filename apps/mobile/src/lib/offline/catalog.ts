/**
 * Offline catalog. The products live twice in the persisted query cache: in the paged lists the
 * screens read (`keys.products`), and in one snapshot map (`keys.catalog()`) that the
 * `/v1/sync/changes` delta feed updates and that answers searches while offline.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/errors';
import { keys } from '@/lib/api/keys';
import { pullChanges } from '@/lib/api/sync';
import type { Category, Change, Page, Product, Store } from '@/lib/api/types';
import type { ListProductsParams } from '@/lib/api/products';

export type CatalogSnapshot = {
  /** Cursor of the last applied change page; null before the first snapshot. */
  cursor: string | null;
  products: Record<string, Product>;
};

const empty = (): CatalogSnapshot => ({ cursor: null, products: {} });

export const getCatalog = (qc: QueryClient): CatalogSnapshot =>
  qc.getQueryData<CatalogSnapshot>(keys.catalog()) ?? empty();

type Cached = Product | InfiniteData<Page<Product>>;

/** Applies `fn` to every cached product list and detail (the `items` and the detail itself). */
export function mapCachedProducts(
  qc: QueryClient,
  fn: (product: Product) => Product | null,
) {
  qc.setQueriesData<Cached>({ queryKey: keys.products.all() }, (old) => {
    if (!old) return old;
    if ('pages' in old) {
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.flatMap((item) => {
            const next = fn(item);
            return next ? [next] : [];
          }),
        })),
      };
    }
    return fn(old) ?? old;
  });
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

/** The first page of a product search, answered from the snapshot (offline). Null when empty. */
export function localProducts(
  qc: QueryClient,
  params: Omit<ListProductsParams, 'cursor'>,
): InfiniteData<Page<Product>, string | null> | null {
  const all = Object.values(getCatalog(qc).products);
  if (all.length === 0) return null;
  const q = params.q ? fold(params.q.trim()) : '';
  const items = all
    .filter(
      (p) =>
        (params.include_archived || !p.archived) &&
        (!params.category_id || p.category_id === params.category_id) &&
        (!q || fold(p.name ?? '').includes(q) || p.barcode === params.q),
    )
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'vi'));
  return { pages: [{ items, next_cursor: null }], pageParams: [null] };
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

/** Applies change pages to the snapshot and to the other cached entities. Returns new ids. */
function applyChanges(
  qc: QueryClient,
  snapshot: CatalogSnapshot,
  changes: Change[],
): { snapshot: CatalogSnapshot; inserted: boolean; changed: Product[] } {
  const products = { ...snapshot.products };
  let inserted = false;
  const changed: Product[] = [];
  for (const change of changes) {
    if (change.entity === 'product') {
      const product = change.data as Product | undefined;
      if (change.op === 'delete' || !product || product.archived) {
        delete products[change.id];
        mapCachedProducts(qc, (p) => (p.id === change.id ? null : p));
      } else {
        if (!products[change.id]) inserted = true;
        products[change.id] = product;
        changed.push(product);
      }
    } else if (change.entity === 'store' && change.data) {
      qc.setQueryData<Store>(keys.store(), change.data as Store);
    } else if (change.entity === 'category') {
      qc.setQueryData<Category[]>(keys.categories(), (old) => {
        if (!old) return old;
        return change.op === 'delete' || !change.data
          ? old.filter((c) => c.id !== change.id)
          : upsertById(old, change.data as Category);
      });
    }
  }
  return { snapshot: { ...snapshot, products }, inserted, changed };
}

let inflight: Promise<void> | null = null;

export type SyncOptions = {
  /**
   * Runs after the merge with the ids of the products the feed replaced, e.g. to re-apply the
   * stock decrements of sales not yet sent to those products.
   */
  afterMerge?: (qc: QueryClient, changedIds: ReadonlySet<string>) => void;
};

/**
 * Pulls `/v1/sync/changes` until `has_more` is false and merges the result into the cache.
 * A 410 drops the snapshot and pulls a full one. Single flight.
 */
export function syncCatalog(
  qc: QueryClient,
  options: SyncOptions = {},
): Promise<void> {
  inflight ??= (async () => {
    let restarted = false;
    let insertedAny = false;
    const changedIds = new Set<string>();
    try {
      for (;;) {
        const before = getCatalog(qc);
        let feed;
        try {
          feed = await pullChanges(before.cursor);
        } catch (error) {
          if (isApiError(error) && error.status === 410 && !restarted) {
            restarted = true;
            qc.setQueryData<CatalogSnapshot>(keys.catalog(), empty());
            continue;
          }
          throw error;
        }
        const merged = applyChanges(qc, before, feed.changes);
        // A first snapshot fills the map; lists fetched meanwhile are already fresh.
        insertedAny ||= merged.inserted && before.cursor !== null;
        for (const product of merged.changed) {
          changedIds.add(product.id);
        }
        qc.setQueryData<CatalogSnapshot>(keys.catalog(), {
          ...merged.snapshot,
          cursor: feed.cursor,
        });
        const replaced = new Map(merged.changed.map((p) => [p.id, p]));
        mapCachedProducts(qc, (p) => replaced.get(p.id) ?? p);
        if (!feed.has_more) break;
      }
      options.afterMerge?.(qc, changedIds);
      if (insertedAny)
        await qc.invalidateQueries({ queryKey: keys.products.all() });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
