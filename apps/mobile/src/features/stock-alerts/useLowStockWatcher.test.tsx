import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  keys,
  useCreateSale,
  useConfirmReceipt,
  type StockItem,
} from '@/lib/api';
import * as stockApi from '@/lib/api/stock';
import { createReceipt } from '@/lib/api/receipts';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { createTestQueryClient } from '@/test/render';
import { PRODUCT_IDS } from '@/test/mock';
import { registerImage } from '@/test/mock/db';
import { newUuid } from '@/lib/uuid';

import { useLowStockWatcher } from './useLowStockWatcher';

const item = (status: StockItem['status'] = 'low'): StockItem => ({
  product_id: PRODUCT_IDS.coca!,
  name: 'Coca-Cola lon',
  image_url: null,
  stock_quantity: status === 'out' ? 0 : 3,
  low_stock_threshold: 5,
  status,
  updated_at: '2026-10-25T00:00:00Z',
});
let changeState: (state: AppStateStatus) => void;
let remove: jest.Mock;
const initialAppState = AppState.currentState;
beforeEach(() => {
  useLowStockAlerts.setState({ alerts: [] });
  AppState.currentState = 'active';
  remove = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      changeState = listener;
      return { remove };
    });
});
afterEach(() => {
  AppState.currentState = initialAppState;
  jest.restoreAllMocks();
});

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

test('alerts once per product, survives dismissal and remount, and re-alerts after recovery', async () => {
  let items = [item()];
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockImplementation(async ({ status } = {}) => ({
      items: items.filter((i) => i.status === status),
      next_cursor: null,
    }));
  const { wrapper, queryClient } = setup();
  const hook = await renderHook(useLowStockWatcher, { wrapper });
  await waitFor(() =>
    expect(useLowStockAlerts.getState().alerts).toHaveLength(1),
  );
  await act(() => useLowStockAlerts.getState().dismiss(item().product_id));
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  expect(useLowStockAlerts.getState().alerts).toHaveLength(0);
  await hook.unmount();
  await renderHook(useLowStockWatcher, { wrapper });
  // Fresh cache (staleTime) is reused on remount; refetch explicitly so the
  // dismissed product is seen again by the new watcher.
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(6));
  expect(useLowStockAlerts.getState().alerts).toHaveLength(0);
  items = [];
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  await waitFor(() =>
    expect(useLowStockAlerts.getState().seenProductIds).toEqual([]),
  );
  items = [item()];
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  await waitFor(() =>
    expect(useLowStockAlerts.getState().alerts).toHaveLength(1),
  );
});

test('includes out stock and low-to-out does not re-alert a dismissed product', async () => {
  let items = [item()];
  jest
    .spyOn(stockApi, 'listStock')
    .mockImplementation(async ({ status } = {}) => ({
      items: items.filter((i) => i.status === status),
      next_cursor: null,
    }));
  const { wrapper, queryClient } = setup();
  await renderHook(useLowStockWatcher, { wrapper });
  await waitFor(() =>
    expect(useLowStockAlerts.getState().alerts).toHaveLength(1),
  );
  await act(() => useLowStockAlerts.getState().dismiss(item().product_id));
  items = [item('out')];
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  expect(useLowStockAlerts.getState().alerts).toHaveLength(0);
});

test('foreground refetches both filters without periodic polling and cleans up', async () => {
  jest.useFakeTimers();
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValue({ items: [], next_cursor: null });
  const { wrapper } = setup();
  const hook = await renderHook(useLowStockWatcher, { wrapper });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  await act(() => jest.advanceTimersByTime(5 * 60 * 1000));
  expect(spy).toHaveBeenCalledTimes(2);
  await act(() => changeState('background'));
  await act(() => jest.advanceTimersByTime(10 * 60 * 1000));
  expect(spy).toHaveBeenCalledTimes(2);
  await act(() => changeState('active'));
  expect(spy).toHaveBeenCalledTimes(4);
  await act(() => changeState('active'));
  expect(spy).toHaveBeenCalledTimes(4);
  await hook.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTime(5 * 60 * 1000));
  expect(spy).toHaveBeenCalledTimes(4);
});

test('screen focus refetches both filters once the data is stale and never while fresh', async () => {
  jest.useFakeTimers();
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValue({ items: [], next_cursor: null });
  const { wrapper } = setup();
  const hook = await renderHook(useLowStockWatcher, { wrapper });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  // Rapid tab switches inside the 60 s staleTime do not refetch.
  await act(() => jest.advanceTimersByTime(30_000));
  await act(() => hook.result.current.refreshOnFocus());
  await act(() => hook.result.current.refreshOnFocus());
  expect(spy).toHaveBeenCalledTimes(2);
  // Stale: one refetch per filter, then fresh again.
  await act(() => jest.advanceTimersByTime(31_000));
  await act(() => hook.result.current.refreshOnFocus());
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(4));
  await act(() => hook.result.current.refreshOnFocus());
  expect(spy).toHaveBeenCalledTimes(4);
  // Focus is the only trigger: no periodic fetch.
  await act(() => jest.advanceTimersByTime(10 * 60 * 1000));
  expect(spy).toHaveBeenCalledTimes(4);
});

test('reconnect refreshes both filters even when cached data is fresh', async () => {
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValue({ items: [], next_cursor: null });
  const { wrapper, queryClient } = setup();
  queryClient.setDefaultOptions({
    queries: { staleTime: Infinity, retry: false, gcTime: Infinity },
  });
  onlineManager.setOnline(false);
  await renderHook(useLowStockWatcher, { wrapper });
  await act(async () => onlineManager.setOnline(true));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  await act(async () => onlineManager.setOnline(false));
  await act(async () => onlineManager.setOnline(true));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(4));
});

test('a failed or incomplete result does not count missing products as recovered', async () => {
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockImplementation(async ({ status } = {}) => ({
      items: status === 'low' ? [item()] : [],
      next_cursor: null,
    }));
  const { wrapper, queryClient } = setup();
  await renderHook(useLowStockWatcher, { wrapper });
  await waitFor(() =>
    expect(useLowStockAlerts.getState().alerts).toHaveLength(1),
  );
  await act(() => useLowStockAlerts.getState().dismiss(item().product_id));
  spy.mockResolvedValue({ items: [], next_cursor: 'more' });
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  spy.mockRejectedValue(new Error('offline'));
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  spy.mockImplementation(async ({ status } = {}) => ({
    items: status === 'low' ? [item()] : [],
    next_cursor: null,
  }));
  await act(() =>
    queryClient.invalidateQueries({ queryKey: keys.stock.all() }),
  );
  expect(useLowStockAlerts.getState().alerts).toHaveLength(0);
});

test('sale invalidation immediately detects low stock; receipt confirmation clears recovered stock', async () => {
  const { wrapper } = setup();
  await stockApi.adjustStock(PRODUCT_IDS.coca!, { count: 6 });
  const hook = await renderHook(
    () => {
      useLowStockWatcher();
      return { sale: useCreateSale(), confirm: useConfirmReceipt(receiptId) };
    },
    { wrapper },
  );
  await waitFor(() =>
    expect(useLowStockAlerts.getState().alerts.length).toBeGreaterThan(0),
  );
  expect(
    useLowStockAlerts
      .getState()
      .alerts.some((a) => a.product_id === PRODUCT_IDS.coca),
  ).toBe(false);
  await act(() =>
    hook.result.current.sale.mutateAsync({
      id: newUuid(),
      sold_at: new Date().toISOString(),
      payment_method: 'cash',
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
  await waitFor(() =>
    expect(
      useLowStockAlerts
        .getState()
        .alerts.some((a) => a.product_id === PRODUCT_IDS.coca),
    ).toBe(true),
  );
  await act(() =>
    hook.result.current.confirm.mutateAsync({
      lines: [{ product_id: PRODUCT_IDS.coca!, quantity: 12, cost: 100000 }],
      paid_with: 'cash_box',
    }),
  );
  await waitFor(() =>
    expect(
      useLowStockAlerts
        .getState()
        .alerts.some((a) => a.product_id === PRODUCT_IDS.coca),
    ).toBe(false),
  );
});

let receiptId: string;
beforeEach(async () => {
  receiptId = (
    await createReceipt({
      image_id: registerImage({ contentType: 'image/jpeg', byteSize: 100 }).id,
    })
  ).id;
});
