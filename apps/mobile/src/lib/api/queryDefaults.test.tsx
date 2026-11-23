import { QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createAppQueryClient } from '@/lib/offline/persist';
import { resetMockDb, PRODUCT_IDS } from '@/test/mock';
import { newUuid } from '@/lib/uuid';
import { resetApiClient } from './client';
import { useCreateSale, useMe, useProducts, useTodayReport } from './hooks';
import * as products from './products';
import * as ledger from './ledger';
import * as store from './store';
import { keys } from './keys';

beforeEach(() => {
  resetMockDb();
  resetApiClient();
});
const clients: ReturnType<typeof createAppQueryClient>[] = [];
afterEach(async () => {
  await cleanup();
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});

function setup() {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    mutations: { gcTime: Infinity },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

test('cart products do not refetch on a prompt remount', async () => {
  const { wrapper } = setup();
  const fetch = jest.spyOn(products, 'listProducts');
  const first = await renderHook(() => useProducts(), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await first.unmount();
  const second = await renderHook(() => useProducts(), { wrapper });
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('report remains fresh after the general stale window', async () => {
  const { client, wrapper } = setup();
  const fetch = jest.spyOn(ledger, 'getTodayReport');
  const first = await renderHook(() => useTodayReport(), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await first.unmount();
  await act(async () => {
    client.setQueryData(keys.reports.today(), first.result.current.data, {
      updatedAt: Date.now() - 61_000,
    });
  });
  await renderHook(() => useTodayReport(), { wrapper });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('me refetches on remount', async () => {
  const { wrapper } = setup();
  const fetch = jest.spyOn(store, 'getMe');
  const first = await renderHook(() => useMe(), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await first.unmount();
  await renderHook(() => useMe(), { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

test('sale invalidates fresh products and refetches the active report', async () => {
  const { client, wrapper } = setup();
  client.setQueryData(keys.products.list(), { pages: [], pageParams: [] });
  const report = await renderHook(() => useTodayReport(), { wrapper });
  await waitFor(() => expect(report.result.current.isSuccess).toBe(true));
  const before = report.result.current.data!.revenue;
  const sale = await renderHook(() => useCreateSale(), { wrapper });
  await act(async () => {
    await sale.result.current.mutateAsync({
      id: newUuid(),
      sold_at: new Date().toISOString(),
      payment_method: 'cash',
      total: 10000,
      lines: [
        {
          id: newUuid(),
          product_id: PRODUCT_IDS.coca,
          source: 'camera',
          quantity: 1,
          unit_price: 10000,
        },
      ],
    });
  });
  expect(client.getQueryState(keys.products.list())?.isInvalidated).toBe(true);
  await waitFor(() =>
    expect(report.result.current.data!.revenue).toBe(before + 10000),
  );
});
