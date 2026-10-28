import { dehydrate, hydrate } from '@tanstack/react-query';

import { setApiTransport } from '@/lib/api';
import { keys } from '@/lib/api/keys';
import type { Change, Product } from '@/lib/api/types';
import { createTestQueryClient } from '@/test/render';

import {
  getCatalog,
  localProducts,
  syncCatalog,
  type CatalogSnapshot,
} from './catalog';
import { decrementLocalStock } from './localStock';
import { shouldPersistQuery } from './persist';

const product = (id: string, over: Partial<Product> = {}): Product => ({
  id,
  name: `Hàng ${id}`,
  price: 10_000,
  base_unit: 'cái',
  units: [],
  images: [],
  index_status: 'ready',
  stock_quantity: 5,
  low_stock_threshold: null,
  stock_status: 'ok',
  archived: false,
  version: 1,
  updated_at: '2026-10-28T00:00:00Z',
  ...over,
});

const upsert = (p: Product): Change => ({
  seq: 1,
  entity: 'product',
  op: 'upsert',
  id: p.id,
  data: p,
});

type Feed = { changes: Change[]; cursor: string; has_more: boolean };

/** Serves `/v1/sync/changes` from a script; records the `since` of every pull. */
function feedTransport(script: (since: string | null) => Feed | number) {
  const sinces: (string | null)[] = [];
  setApiTransport((async (input: Request) => {
    const url = new URL(input.url);
    if (url.pathname !== '/v1/sync/changes') throw new Error(url.pathname);
    const since = url.searchParams.get('since');
    sinces.push(since);
    const out = script(since);
    return typeof out === 'number'
      ? new Response(JSON.stringify({ error: 'gone' }), {
          status: out,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  }) as typeof fetch);
  return sinces;
}

describe('syncCatalog', () => {
  it('pulls a full snapshot across pages, then only the delta', async () => {
    const qc = createTestQueryClient();
    const a = product('a');
    const b = product('b');
    const sinces = feedTransport((since) => {
      if (since === null)
        return { changes: [upsert(a)], cursor: 'c1', has_more: true };
      if (since === 'c1')
        return { changes: [upsert(b)], cursor: 'c2', has_more: false };
      return {
        changes: [upsert({ ...a, price: 12_000, version: 2 })],
        cursor: 'c3',
        has_more: false,
      };
    });
    await syncCatalog(qc);
    expect(sinces).toEqual([null, 'c1']);
    expect(Object.keys(getCatalog(qc).products).sort()).toEqual(['a', 'b']);
    await syncCatalog(qc);
    expect(sinces).toEqual([null, 'c1', 'c2']);
    expect(getCatalog(qc)).toMatchObject({ cursor: 'c3' });
    expect(getCatalog(qc).products['a']!.price).toBe(12_000);
  });

  it('patches products already in cached lists, drops deleted and archived ones', async () => {
    const qc = createTestQueryClient();
    const a = product('a');
    const b = product('b');
    const c = product('c');
    qc.setQueryData(keys.products.list({}), {
      pages: [{ items: [a, b, c], next_cursor: null }],
      pageParams: [null],
    });
    qc.setQueryData(keys.products.detail('a'), a);
    feedTransport(() => ({
      changes: [
        upsert({ ...a, price: 99 }),
        { seq: 2, entity: 'product', op: 'delete', id: 'b' },
        upsert({ ...c, archived: true }),
      ],
      cursor: 'c1',
      has_more: false,
    }));
    await syncCatalog(qc);
    const list = qc.getQueryData<{ pages: { items: Product[] }[] }>(
      keys.products.list({}),
    )!;
    expect(list.pages[0]!.items.map((p) => [p.id, p.price])).toEqual([
      ['a', 99],
    ]);
    expect(qc.getQueryData<Product>(keys.products.detail('a'))!.price).toBe(99);
  });

  it('invalidates the lists when a later delta brings a new product', async () => {
    const qc = createTestQueryClient();
    qc.setQueryData<CatalogSnapshot>(keys.catalog(), {
      cursor: 'c0',
      products: { a: product('a') },
    });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    feedTransport(() => ({
      changes: [upsert(product('n'))],
      cursor: 'c1',
      has_more: false,
    }));
    await syncCatalog(qc);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.products.all() });
  });

  it('starts over with a full snapshot on 410 (cursor compacted)', async () => {
    const qc = createTestQueryClient();
    qc.setQueryData<CatalogSnapshot>(keys.catalog(), {
      cursor: 'old',
      products: { gone: product('gone') },
    });
    const sinces = feedTransport((since) =>
      since === 'old'
        ? 410
        : { changes: [upsert(product('a'))], cursor: 'c1', has_more: false },
    );
    await syncCatalog(qc);
    expect(sinces).toEqual(['old', null]);
    expect(Object.keys(getCatalog(qc).products)).toEqual(['a']);
  });

  it('re-applies the stock of unsent sales to products the feed replaced', async () => {
    const qc = createTestQueryClient();
    const a = product('a', { stock_quantity: 5 });
    const other = product('o', { stock_quantity: 5 });
    qc.setQueryData(keys.products.detail('o'), other);
    feedTransport(() => ({
      changes: [upsert(a)],
      cursor: 'c1',
      has_more: false,
    }));
    const sale = {
      lines: [
        { product_id: 'a', quantity: 2 },
        { product_id: 'o', quantity: 1 },
      ],
    } as never;
    await syncCatalog(qc, {
      afterMerge: (client, ids) => decrementLocalStock(client, sale, ids),
    });
    expect(getCatalog(qc).products['a']!.stock_quantity).toBe(3);
    expect(
      qc.getQueryData<Product>(keys.products.detail('o'))!.stock_quantity,
    ).toBe(5);
  });
});

describe('local stock and search', () => {
  it('takes sold quantity off lists, details and the snapshot; untracked stays null', () => {
    const qc = createTestQueryClient();
    const a = product('a', { stock_quantity: 2 });
    const u = product('u', { stock_quantity: null, stock_status: 'untracked' });
    qc.setQueryData(keys.products.list({}), {
      pages: [{ items: [a, u], next_cursor: null }],
      pageParams: [null],
    });
    qc.setQueryData<CatalogSnapshot>(keys.catalog(), {
      cursor: 'c',
      products: { a, u },
    });
    decrementLocalStock(qc, {
      lines: [
        { product_id: 'a', quantity: 2 },
        { product_id: 'u', quantity: 1 },
      ],
    } as never);
    const items = qc.getQueryData<{ pages: { items: Product[] }[] }>(
      keys.products.list({}),
    )!.pages[0]!.items;
    expect(items.map((p) => [p.stock_quantity, p.stock_status])).toEqual([
      [0, 'out'],
      [null, 'untracked'],
    ]);
    expect(getCatalog(qc).products['a']!.stock_quantity).toBe(0);
  });

  it('answers a search from the snapshot, ignoring diacritics and archived items', () => {
    const qc = createTestQueryClient();
    qc.setQueryData<CatalogSnapshot>(keys.catalog(), {
      cursor: 'c',
      products: {
        a: product('a', { name: 'Đường cát' }),
        b: product('b', { name: 'Sữa tươi' }),
        c: product('c', { name: 'Đường phèn', archived: true }),
      },
    });
    const names = (q?: string) =>
      localProducts(qc, { q })!.pages[0]!.items.map((p) => p.name);
    expect(names('duong')).toEqual(['Đường cát']);
    expect(names()).toEqual(['Đường cát', 'Sữa tươi']);
  });
});

describe('persisted cache', () => {
  it('keeps the catalog, store and me across a restart and leaves reports out', () => {
    const qc = createTestQueryClient();
    qc.setQueryData(keys.catalog(), {
      cursor: 'c1',
      products: { a: product('a') },
    });
    qc.setQueryData(keys.products.list({}), {
      pages: [{ items: [product('a')], next_cursor: null }],
      pageParams: [null],
    });
    qc.setQueryData(keys.store(), { id: 's1' });
    qc.setQueryData(keys.me('u1'), { clerk_user_id: 'u1' });
    qc.setQueryData(keys.reports.today(), { revenue: 1 });
    const saved = JSON.parse(
      JSON.stringify(
        dehydrate(qc, { shouldDehydrateQuery: shouldPersistQuery }),
      ),
    );
    const restored = createTestQueryClient();
    hydrate(restored, saved);
    expect(getCatalog(restored)).toMatchObject({ cursor: 'c1' });
    expect(restored.getQueryData(keys.store())).toEqual({ id: 's1' });
    expect(restored.getQueryData(keys.me('u1'))).toBeDefined();
    expect(restored.getQueryData(keys.products.list({}))).toBeDefined();
    expect(restored.getQueryData(keys.reports.today())).toBeUndefined();
  });
});
