import {
  QueryClientProvider,
  environmentManager,
  focusManager,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createTestQueryClient } from '@/test/render';
import { resetMockDb, setMockScenario, PRODUCT_IDS } from '@/test/mock';
import { registerImage } from '@/test/mock/db';
import { addDays, businessDate } from '@/lib/date';
import { newUuid } from '@/lib/uuid';

import { resetApiClient } from './client';
import * as productsApi from './products';
import {
  applyProductIndexed,
  summaryRange,
  useAcceptAlert,
  useAddProductImage,
  useAlerts,
  useCategories,
  useCreateDayClose,
  useCreateExpense,
  useCreateInvite,
  useCreateProduct,
  useCreateSale,
  useCreateScan,
  useDayClose,
  useDismissAlert,
  useExpenses,
  useManualLines,
  useResolveManualLine,
  useMe,
  useMembers,
  usePatchProduct,
  usePatchStore,
  useProduct,
  useProducts,
  useReportSummary,
  useSales,
  useSegmentPoints,
  useStore,
  useTodayReport,
  useUploadImage,
} from './hooks';
import { keys } from './keys';
import type { Product } from './types';

beforeEach(() => {
  resetMockDb();
  resetApiClient();
});

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/** Runs an async action inside act() and returns its value. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await fn();
  });
  return value;
}

const jpeg = () => new Blob(['x'], { type: 'image/jpeg' });

describe('queries', () => {
  test('simple queries load from the mock API', async () => {
    const { wrapper } = setup();
    const me = await renderHook(() => useMe(), { wrapper });
    const store = await renderHook(() => useStore(), { wrapper });
    const members = await renderHook(() => useMembers(), { wrapper });
    const categories = await renderHook(() => useCategories(), { wrapper });
    const alerts = await renderHook(() => useAlerts(), { wrapper });
    const sales = await renderHook(() => useSales({ limit: 3 }), { wrapper });
    const expenses = await renderHook(() => useExpenses(), { wrapper });
    const report = await renderHook(() => useTodayReport(), { wrapper });
    await waitFor(() => {
      for (const q of [
        me,
        store,
        members,
        categories,
        alerts,
        sales,
        expenses,
        report,
      ]) {
        expect(q.result.current.isSuccess).toBe(true);
      }
    });
    expect(me.result.current.data?.member.role).toBe('lead');
    expect(store.result.current.data?.name).toBe('Tạp hóa Cô Ba');
    expect(members.result.current.data).toHaveLength(3);
    expect(categories.result.current.data).toHaveLength(5);
    expect(alerts.result.current.data).toHaveLength(2);
    expect(sales.result.current.data?.items).toHaveLength(3);
    expect(report.result.current.data?.business_date).toBe(businessDate());
  });

  test('useProducts searches, flattens pages and fetches the next cursor', async () => {
    const { wrapper } = setup();
    const search = await renderHook(() => useProducts({ q: 'sua' }), {
      wrapper,
    });
    await waitFor(() => expect(search.result.current.isSuccess).toBe(true));
    expect(search.result.current.data?.map((p) => p.name)).toEqual([
      'Sữa Vinamilk 180ml',
    ]);

    const paged = await renderHook(() => useProducts({ limit: 5 }), {
      wrapper,
    });
    await waitFor(() => expect(paged.result.current.data).toHaveLength(5));
    expect(paged.result.current.hasNextPage).toBe(true);
    await run(() => paged.result.current.fetchNextPage());
    await waitFor(() => expect(paged.result.current.data).toHaveLength(10));
  });

  test('useProduct is disabled without an id and loads by id', async () => {
    const { wrapper } = setup();
    const none = await renderHook(() => useProduct(undefined), { wrapper });
    expect(none.result.current.fetchStatus).toBe('idle');
    const one = await renderHook(() => useProduct(PRODUCT_IDS.coca), {
      wrapper,
    });
    await waitFor(() =>
      expect(one.result.current.data?.name).toBe('Coca-Cola lon 330ml'),
    );
    const missingId = newUuid();
    const missing = await renderHook(() => useProduct(missingId), { wrapper });
    await waitFor(() => expect(missing.result.current.isError).toBe(true));
    expect(missing.result.current.error).toMatchObject({ status: 404 });
  });

  test.each(['day', 'week', 'month'] as const)(
    'useReportSummary(%s)',
    async (period) => {
      const { wrapper } = setup();
      const { result } = await renderHook(() => useReportSummary(period), {
        wrapper,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.granularity).toBe(period);
      const last = result.current.data!.buckets.at(-1)!;
      expect(last.end).toBe(businessDate());
    },
  );

  test('summaryRange: 7 days, ~6 weeks, 6 months ending today', () => {
    const now = new Date('2026-10-23T05:00:00Z');
    expect(summaryRange('day', now)).toEqual({
      from: '2026-10-17',
      to: '2026-10-23',
      granularity: 'day',
    });
    expect(summaryRange('week', now)).toEqual({
      from: '2026-09-14',
      to: '2026-10-23',
      granularity: 'week',
    });
    expect(summaryRange('month', now)).toEqual({
      from: '2026-05-01',
      to: '2026-10-23',
      granularity: 'month',
    });
  });

  test('useDayClose resolves null for an open day and the close once created', async () => {
    const { wrapper } = setup();
    const date = businessDate();
    const open = await renderHook(() => useDayClose(date), { wrapper });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    expect(open.result.current.data).toBeNull();

    const closed = await renderHook(() => useDayClose(addDays(date, -1)), {
      wrapper,
    });
    await waitFor(() =>
      expect(closed.result.current.data?.business_date).toBe(addDays(date, -1)),
    );
  });

  test('useDayClose surfaces non-404 errors', async () => {
    const { wrapper } = setup();
    const { result } = await renderHook(() => useDayClose('not-a-date'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 400 });
  });
});

describe('mutations and invalidation', () => {
  const sale = () => ({
    id: newUuid(),
    sold_at: new Date().toISOString(),
    payment_method: 'cash' as const,
    total: 10000,
    lines: [
      {
        id: newUuid(),
        product_id: PRODUCT_IDS.coca,
        source: 'camera' as const,
        quantity: 1,
        unit_price: 10000,
      },
    ],
  });

  test('useCreateSale invalidates sales, reports, products and alerts', async () => {
    const { wrapper, queryClient } = setup();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const report = await renderHook(() => useTodayReport(), { wrapper });
    await waitFor(() => expect(report.result.current.isSuccess).toBe(true));
    const before = report.result.current.data!.revenue;

    const { result } = await renderHook(() => useCreateSale(), { wrapper });
    await run(() => result.current.mutateAsync(sale()));
    const invalidated = spy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(invalidated).toEqual(
      expect.arrayContaining([
        keys.sales.all(),
        keys.reports.all(),
        keys.products.all(),
        keys.alerts.all(),
      ]),
    );
    await waitFor(() =>
      expect(report.result.current.data!.revenue).toBe(before + 10000),
    );
  });

  test('useCreateExpense invalidates reports; purchase lines also products and alerts', async () => {
    const { wrapper, queryClient } = setup();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = await renderHook(() => useCreateExpense(), { wrapper });
    const base = {
      spent_at: new Date().toISOString(),
      amount: 1000,
      category: 'khac' as const,
      paid_with: 'cash_box' as const,
    };
    await run(() => result.current.mutateAsync({ ...base, id: newUuid() }));
    let keysSeen = spy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keysSeen).toEqual(
      expect.arrayContaining([keys.expenses.all(), keys.reports.all()]),
    );
    expect(keysSeen).not.toContainEqual(keys.products.all());
    spy.mockClear();
    await run(() =>
      result.current.mutateAsync({
        ...base,
        id: newUuid(),
        purchase_lines: [
          { product_id: PRODUCT_IDS.coca, quantity: 1, unit_cost: 7000 },
        ],
      }),
    );
    keysSeen = spy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keysSeen).toEqual(
      expect.arrayContaining([keys.products.all(), keys.alerts.all()]),
    );
  });

  test('scan, upload, create product, add image, patch product', async () => {
    const { wrapper, queryClient } = setup();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const scan = await renderHook(() => useCreateScan(), { wrapper });
    const upload = await renderHook(() => useUploadImage(), { wrapper });
    const create = await renderHook(() => useCreateProduct(), { wrapper });
    const addImage = await renderHook(() => useAddProductImage(), { wrapper });
    const patch = await renderHook(() => usePatchProduct(), { wrapper });

    setMockScenario('unknown');
    const scanned = await run(() =>
      scan.result.current.mutateAsync({
        image: jpeg(),
        mode: 'single',
        purpose: 'enrollment',
      }),
    );
    expect(scanned.detections[0]!.match).toBe('unknown');

    const id = newUuid();
    const product = await run(() =>
      create.result.current.mutateAsync({
        id,
        price: 9000,
        image_ids: [scanned.image.id],
        name: 'Mới',
        force_new: false,
      }),
    );
    expect(product.images[0]!.image_id).toBe(scanned.image.id);

    const image = await run(() =>
      upload.result.current.mutateAsync({
        file: jpeg(),
        purpose: 'enrollment',
      }),
    );
    await run(() =>
      addImage.result.current.mutateAsync({ id, image_id: image.id }),
    );
    const patched = await run(() =>
      patch.result.current.mutateAsync({ id, patch: { price: 9500 } }),
    );
    expect(patched).toMatchObject({ price: 9500, version: 3 });
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.products.all() });
  });

  test('alerts: accept and dismiss refresh the alert list', async () => {
    const { wrapper } = setup();
    const alerts = await renderHook(() => useAlerts(), { wrapper });
    const accept = await renderHook(() => useAcceptAlert(), { wrapper });
    const dismiss = await renderHook(() => useDismissAlert(), { wrapper });
    await waitFor(() => expect(alerts.result.current.data).toHaveLength(2));
    const [first, second] = alerts.result.current.data!;
    await run(() => accept.result.current.mutateAsync({ id: first!.id }));
    await waitFor(() => expect(alerts.result.current.data).toHaveLength(1));
    await run(() => dismiss.result.current.mutateAsync(second!.id));
    await waitFor(() => expect(alerts.result.current.data).toHaveLength(0));
  });

  test('day close refreshes reports and the day-close query', async () => {
    const { wrapper } = setup();
    const date = businessDate();
    const close = await renderHook(() => useDayClose(date), { wrapper });
    const report = await renderHook(() => useTodayReport(), { wrapper });
    const create = await renderHook(() => useCreateDayClose(), { wrapper });
    await waitFor(() => expect(close.result.current.data).toBeNull());
    await run(() =>
      create.result.current.mutateAsync({
        date,
        counted_cash: 100000,
        opening_float: 0,
        note: 'ok',
      }),
    );
    await waitFor(() =>
      expect(close.result.current.data?.counted_cash).toBe(100000),
    );
    await waitFor(() =>
      expect(report.result.current.data?.day_close?.counted_cash).toBe(100000),
    );
  });

  test('store patch and invites refresh store, me and members', async () => {
    const { wrapper } = setup();
    const store = await renderHook(() => useStore(), { wrapper });
    const patch = await renderHook(() => usePatchStore(), { wrapper });
    const invite = await renderHook(() => useCreateInvite(), { wrapper });
    // Touch `data` first: react-query only re-renders on props that were read.
    await waitFor(() =>
      expect(store.result.current.data?.name).toBe('Tạp hóa Cô Ba'),
    );
    await run(() => patch.result.current.mutateAsync({ name: 'Tiệm mới' }));
    await waitFor(() =>
      expect(store.result.current.data?.name).toBe('Tiệm mới'),
    );
    const created = await run(() =>
      invite.result.current.mutateAsync({ role: 'seller' }),
    );
    expect(created.join_url).toContain('taphoa://join');
  });
});

describe('manual lines', () => {
  test('useManualLines lists open lines; resolving refreshes the list', async () => {
    const { wrapper, queryClient } = setup();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const lines = await renderHook(() => useManualLines(), { wrapper });
    const resolve = await renderHook(() => useResolveManualLine(), { wrapper });
    await waitFor(() =>
      expect(lines.result.current.data?.items).toHaveLength(3),
    );
    const first = lines.result.current.data!.items[0]!;
    await run(() =>
      resolve.result.current.mutateAsync({
        lineId: first.line_id,
        action: 'link',
        product_id: PRODUCT_IDS.coca,
      }),
    );
    await waitFor(() =>
      expect(lines.result.current.data?.items).toHaveLength(2),
    );
    await run(() =>
      resolve.result.current.mutateAsync({
        lineId: lines.result.current.data!.items[0]!.line_id,
        action: 'dismiss',
      }),
    );
    const keysSeen = spy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keysSeen).toEqual(
      expect.arrayContaining([
        keys.manualLines.all(),
        keys.reports.all(),
        keys.products.all(),
      ]),
    );
  });
});

describe('usePatchProduct', () => {
  afterEach(() => jest.restoreAllMocks());

  const price = (qc: ReturnType<typeof createTestQueryClient>) =>
    qc.getQueryData<{ price: number }>(keys.products.detail(PRODUCT_IDS.coca))
      ?.price;

  test('applies the price optimistically and rolls back after the screen unmounted', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(
      keys.products.detail(PRODUCT_IDS.coca),
      await productsApi.getProduct(PRODUCT_IDS.coca),
    );
    let reject: (error: Error) => void = () => undefined;
    jest.spyOn(productsApi, 'patchProduct').mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const patch = await renderHook(() => usePatchProduct(), { wrapper });

    await act(async () => {
      patch.result.current.mutate({
        id: PRODUCT_IDS.coca,
        patch: { price: 10005 },
      });
    });
    await waitFor(() => expect(price(queryClient)).toBe(10005));

    await patch.unmount();
    await act(async () => reject(new Error('boom')));

    await waitFor(() => expect(price(queryClient)).toBe(10000));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: keys.products.all(),
    });
  });

  test('keeps the new price and refetches after success', async () => {
    const { queryClient, wrapper } = setup();
    const patch = await renderHook(() => usePatchProduct(), { wrapper });
    await run(() =>
      patch.result.current.mutateAsync({
        id: PRODUCT_IDS.coca,
        patch: { price: 12000 },
      }),
    );
    expect((await productsApi.getProduct(PRODUCT_IDS.coca)).price).toBe(12000);
    expect(price(queryClient)).not.toBe(10000);
  });
});

describe('quick enroll: useSegmentPoints, useCreateProduct references, polling, applyProductIndexed', () => {
  test('useSegmentPoints happy path returns mask & cutout; 422 on invalid points', async () => {
    const { wrapper } = setup();
    const img = registerImage({
      contentType: 'image/jpeg',
      byteSize: 1000,
      purpose: 'enrollment',
    });

    const { result } = await renderHook(() => useSegmentPoints(), { wrapper });

    // happy path
    const seg = await run(() =>
      result.current.mutateAsync({
        image_id: img.id,
        points: [{ x: 500, y: 400, label: 1 }],
      }),
    );
    expect(seg.bbox).toHaveLength(4);
    expect(seg.mask.png_base64).toBeTruthy();
    expect(seg.cutout_image_id).toBeDefined();

    // 422 with empty points
    await expect(
      run(() =>
        result.current.mutateAsync({
          image_id: img.id,
          points: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  test('useCreateProduct with references returns product with pending index_status', async () => {
    const { wrapper } = setup();
    const refs = [1, 2, 3].map(() => {
      const orig = registerImage({
        contentType: 'image/jpeg',
        byteSize: 1000,
        purpose: 'enrollment',
      });
      const cutout = registerImage({
        contentType: 'image/png',
        byteSize: 500,
        purpose: 'crop',
      });
      return {
        image_id: orig.id,
        cutout_image_id: cutout.id,
        bbox: [0, 0, 100, 100],
      };
    });

    const { result } = await renderHook(() => useCreateProduct(), { wrapper });
    const product = await run(() =>
      result.current.mutateAsync({
        id: newUuid(),
        price: 25000,
        name: 'Sản phẩm mới',
        force_new: false,
        references: refs,
      }),
    );

    expect(product.index_status).toBe('pending');
  });

  test('useProduct refetches while index_status is pending and stops when ready', async () => {
    environmentManager.setIsServer(() => false);
    focusManager.setFocused(true);
    jest.useFakeTimers();
    try {
      const { wrapper } = setup();
      const mockProductPending: Product = {
        id: PRODUCT_IDS.coca,
        name: 'Coca-Cola lon 330ml',
        price: 10000,
        base_unit: 'lon',
        cost_price: 7500,
        barcode: null,
        category_id: null,
        units: [],
        images: [],
        index_status: 'pending',
        stock_quantity: null,
        low_stock_threshold: null,
        stock_status: 'untracked',
        archived: false,
        version: 1,
        updated_at: new Date().toISOString(),
      };
      const mockProductReady: Product = {
        ...mockProductPending,
        index_status: 'ready',
      };

      let callCount = 0;
      jest.spyOn(productsApi, 'getProduct').mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? mockProductPending : mockProductReady;
      });

      const { result } = await renderHook(() => useProduct(PRODUCT_IDS.coca), {
        wrapper,
      });

      // Let initial fetch resolve
      await jest.advanceTimersByTimeAsync(0);

      expect(result.current.data?.index_status).toBe('pending');
      expect(callCount).toBe(1);

      // Advance by 2 seconds: should trigger refetch
      await jest.advanceTimersByTimeAsync(2000);
      await waitFor(() => {
        expect(result.current.data?.index_status).toBe('ready');
      });
      expect(callCount).toBe(2);

      // Advance by another 4 seconds: should NOT refetch again because status is ready
      await jest.advanceTimersByTimeAsync(4000);

      expect(callCount).toBe(2);
    } finally {
      environmentManager.setIsServer(() => true);
      focusManager.setFocused(undefined);
      jest.useRealTimers();
    }
  });

  test('applyProductIndexed patches cached detail and lists', async () => {
    const { queryClient } = setup();
    const id = newUuid();

    const product: Product = {
      id,
      name: 'Bánh mì',
      price: 15000,
      base_unit: 'ổ',
      cost_price: 10000,
      barcode: null,
      category_id: null,
      units: [],
      images: [],
      index_status: 'pending',
      stock_quantity: null,
      low_stock_threshold: null,
      stock_status: 'untracked',
      archived: false,
      version: 1,
      updated_at: new Date().toISOString(),
    };

    // Cache detail
    queryClient.setQueryData(keys.products.detail(id), product);

    // Cache page list
    queryClient.setQueryData(keys.products.list(), {
      items: [product],
      next_cursor: null,
    });

    // Cache infinite list
    queryClient.setQueryData(keys.products.list({ q: 'banh' }), {
      pages: [{ items: [product], next_cursor: null }],
      pageParams: [null],
    });

    applyProductIndexed(queryClient, {
      product_id: id,
      index_status: 'ready',
      reference_count: 3,
    });

    const cachedDetail = queryClient.getQueryData<Product>(
      keys.products.detail(id),
    );
    expect(cachedDetail?.index_status).toBe('ready');

    const cachedList = queryClient.getQueryData<{ items: Product[] }>(
      keys.products.list(),
    );
    expect(cachedList?.items[0]?.index_status).toBe('ready');

    const cachedInfinite = queryClient.getQueryData<{
      pages: { items: Product[] }[];
    }>(keys.products.list({ q: 'banh' }));
    expect(cachedInfinite?.pages[0]?.items[0]?.index_status).toBe('ready');
  });
});
