import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createTestQueryClient } from '@/test/render';
import { resetMockDb, PRODUCT_IDS } from '@/test/mock';
import { registerImage } from '@/test/mock/db';
import { newUuid } from '@/lib/uuid';

import * as hooks from './hooks';
import { keys } from './keys';
import { createReceipt, listReceipts } from './receipts';
import * as receiptsApi from './receipts';
import * as stockApi from './stock';
import { adjustStock, listStock } from './stock';
import { patchProduct, getProduct } from './products';
import { patchStore } from './store';

beforeEach(resetMockDb);
afterEach(() => jest.restoreAllMocks());
function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}
async function run<T>(fn: () => Promise<T>) {
  let value!: T;
  await act(async () => {
    value = await fn();
  });
  return value;
}
const draft = () =>
  createReceipt({
    image_id: registerImage({
      contentType: 'image/jpeg',
      byteSize: 100,
      purpose: 'expense_receipt',
    }).id,
  });

test('stock filters keep separate keys and follow cursor pages; movements follow pages', async () => {
  const { wrapper } = setup();
  const stock = await renderHook(() => hooks.useStock('all'), { wrapper });
  const low = await renderHook(() => hooks.useStock('low'), { wrapper });
  await waitFor(() => expect(stock.result.current.data).toHaveLength(3));
  await waitFor(() => expect(low.result.current.data?.[0]?.status).toBe('low'));
  expect(stock.result.current.hasNextPage).toBe(false);
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValueOnce({ items: [], next_cursor: 'next' })
    .mockResolvedValueOnce({ items: [], next_cursor: null });
  const paged = await renderHook(() => hooks.useStock('out'), { wrapper });
  await waitFor(() => expect(paged.result.current.hasNextPage).toBe(true));
  await run(() => paged.result.current.fetchNextPage());
  expect(spy).toHaveBeenLastCalledWith({ status: 'out', cursor: 'next' });
  await waitFor(() => expect(paged.result.current.hasNextPage).toBe(false));
  await adjustStock(PRODUCT_IDS.coca!, { count: 22 });
  const movements = await renderHook(
    () => hooks.useStockMovements(PRODUCT_IDS.coca),
    { wrapper },
  );
  await waitFor(() =>
    expect(movements.result.current.data?.[0]?.quantity_after).toBe(22),
  );
  const movementSpy = jest
    .spyOn(stockApi, 'listStockMovements')
    .mockResolvedValueOnce({ items: [], next_cursor: 'movement-next' })
    .mockResolvedValueOnce({ items: [], next_cursor: null });
  const more = await renderHook(
    () => hooks.useStockMovements(PRODUCT_IDS.pepsi),
    { wrapper },
  );
  await waitFor(() => expect(more.result.current.hasNextPage).toBe(true));
  await run(() => more.result.current.fetchNextPage());
  expect(movementSpy).toHaveBeenLastCalledWith(PRODUCT_IDS.pepsi, {
    cursor: 'movement-next',
  });
  await waitFor(() => expect(more.result.current.hasNextPage).toBe(false));
});

test('adjust hook sends stable supplied key and invalidates stock, products and movements', async () => {
  const { wrapper, queryClient } = setup();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  const adjustment = await renderHook(
    () => hooks.useAdjustStock(PRODUCT_IDS.coca!),
    { wrapper },
  );
  const input = { count: 8, idempotencyKey: newUuid() };
  const first = await run(() => adjustment.result.current.mutateAsync(input));
  expect(
    (await run(() => adjustment.result.current.mutateAsync(input))).id,
  ).toBe(first.id);
  for (const key of [
    keys.stock.all(),
    keys.products.all(),
    keys.stockMovements(PRODUCT_IDS.coca!),
  ])
    expect(spy).toHaveBeenCalledWith({ queryKey: key });
});

test('receipt hooks create, query, paginate, confirm and discard; refresh all affected caches', async () => {
  const { wrapper, queryClient } = setup();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  const image = registerImage({ contentType: 'image/jpeg', byteSize: 100 });
  const create = await renderHook(() => hooks.useCreateReceipt(), { wrapper });
  const receipt = await run(() =>
    create.result.current.mutateAsync({
      image_id: image.id,
      idempotencyKey: newUuid(),
    }),
  );
  const list = await renderHook(() => hooks.useReceipts('draft'), { wrapper });
  const detail = await renderHook(() => hooks.useReceipt(receipt.id), {
    wrapper,
  });
  await waitFor(() =>
    expect(list.result.current.data?.[0]?.id).toBe(receipt.id),
  );
  await waitFor(() => expect(detail.result.current.data?.status).toBe('draft'));
  const listSpy = jest
    .spyOn(receiptsApi, 'listReceipts')
    .mockResolvedValueOnce({ items: [], next_cursor: 'receipt-next' })
    .mockResolvedValueOnce({ items: [], next_cursor: null });
  const paged = await renderHook(() => hooks.useReceipts('confirmed'), {
    wrapper,
  });
  await waitFor(() => expect(paged.result.current.hasNextPage).toBe(true));
  await run(() => paged.result.current.fetchNextPage());
  expect(listSpy).toHaveBeenLastCalledWith({
    status: 'confirmed',
    cursor: 'receipt-next',
  });
  await waitFor(() => expect(paged.result.current.hasNextPage).toBe(false));
  listSpy.mockRestore();
  const confirm = await renderHook(() => hooks.useConfirmReceipt(receipt.id), {
    wrapper,
  });
  await run(() =>
    confirm.result.current.mutateAsync({
      lines: receipt.lines.slice(0, 3).map((l) => ({
        product_id: l.product_id!,
        quantity: l.quantity,
        cost: l.cost,
      })),
      paid_with: 'cash_box',
      idempotencyKey: newUuid(),
    }),
  );
  await waitFor(() =>
    expect(detail.result.current.data?.status).toBe('confirmed'),
  );
  for (const key of [
    keys.receipts.all(),
    keys.stock.all(),
    keys.products.all(),
    keys.expenses.all(),
    keys.reports.all(),
  ])
    expect(spy).toHaveBeenCalledWith({ queryKey: key });
  const other = await draft();
  const discard = await renderHook(() => hooks.useDiscardReceipt(other.id), {
    wrapper,
  });
  await run(() => discard.result.current.mutateAsync());
  expect((await listReceipts({ status: 'draft' })).items).toHaveLength(0);
});

test('threshold patches recompute stock status and invalidate stock views', async () => {
  await patchProduct(PRODUCT_IDS.coca!, { low_stock_threshold: 22 });
  expect((await getProduct(PRODUCT_IDS.coca!)).stock_status).toBe('low');
  await patchProduct(PRODUCT_IDS.coca!, { low_stock_threshold: null });
  await patchStore({ low_stock_threshold: 22 });
  expect((await getProduct(PRODUCT_IDS.coca!)).stock_status).toBe('low');
  expect(
    (await listStock()).items.find((p) => p.product_id === PRODUCT_IDS.coca)
      ?.low_stock_threshold,
  ).toBe(22);
  const { wrapper, queryClient } = setup();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  const store = await renderHook(() => hooks.usePatchStore(), { wrapper });
  const product = await renderHook(() => hooks.usePatchProduct(), { wrapper });
  await run(() => store.result.current.mutateAsync({ low_stock_threshold: 4 }));
  await run(() =>
    product.result.current.mutateAsync({
      id: PRODUCT_IDS.coca!,
      patch: { low_stock_threshold: 2 },
    }),
  );
  expect(
    spy.mock.calls.filter(
      ([args]) =>
        JSON.stringify(args?.queryKey) === JSON.stringify(keys.stock.all()),
    ),
  ).toHaveLength(2);
});

test('missing receipt/product ids disable detail queries', async () => {
  const { wrapper } = setup();
  const receipt = await renderHook(() => hooks.useReceipt(undefined), {
    wrapper,
  });
  const movements = await renderHook(() => hooks.useStockMovements(undefined), {
    wrapper,
  });
  expect(receipt.result.current.fetchStatus).toBe('idle');
  expect(movements.result.current.fetchStatus).toBe('idle');
});

test('automatic receipt mutation retry reuses its generated Idempotency-Key', async () => {
  const { wrapper, queryClient } = setup();
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    mutations: { retry: 1, retryDelay: 0, gcTime: Infinity },
  });
  const original = receiptsApi.createReceipt;
  const spy = jest
    .spyOn(receiptsApi, 'createReceipt')
    .mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('Response lost after server committed');
    });
  const image = registerImage({ contentType: 'image/jpeg', byteSize: 1 });
  const create = await renderHook(() => hooks.useCreateReceipt(), { wrapper });
  await run(() => create.result.current.mutateAsync({ image_id: image.id }));
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls[0]![1]).toEqual(expect.any(String));
  expect(spy.mock.calls[1]![1]).toBe(spy.mock.calls[0]![1]);
  expect((await listReceipts()).items).toHaveLength(1);
});

test('sales invalidate the stock and movements views alongside products', async () => {
  const { wrapper, queryClient } = setup();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  const sale = await renderHook(() => hooks.useCreateSale(), { wrapper });
  await run(() =>
    sale.result.current.mutateAsync({
      id: newUuid(),
      sold_at: new Date().toISOString(),
      payment_method: 'transfer',
      total: 10000,
      lines: [
        {
          id: newUuid(),
          product_id: PRODUCT_IDS.coca,
          quantity: 1,
          unit_price: 10000,
          source: 'grid',
        },
      ],
    }),
  );
  expect(spy).toHaveBeenCalledWith({ queryKey: keys.stock.all() });
  expect(spy).toHaveBeenCalledWith({
    queryKey: [...keys.all, 'stock-movements'],
  });
});
