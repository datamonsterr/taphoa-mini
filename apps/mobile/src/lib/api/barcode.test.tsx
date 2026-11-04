import { act, renderHook } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createTestQueryClient } from '@/test/render';
import { PRODUCT_IDS, resetMockDb } from '@/test/mock';
import * as products from './products';
import { useLookupBarcode } from './hooks';
import { keys } from './keys';

beforeEach(() => resetMockDb());
afterEach(() => jest.restoreAllMocks());

test('exact barcode query caches per session and refreshes after catalog invalidation', async () => {
  await products.patchProduct(PRODUCT_IDS.coca, { barcode: '4006381333931' });
  const calls = jest.spyOn(products, 'listProducts');
  const client = createTestQueryClient();
  const { result } = await renderHook(() => useLookupBarcode(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    expect((await result.current('4006381333931'))?.id).toBe(PRODUCT_IDS.coca);
    expect((await result.current('4006381333931'))?.id).toBe(PRODUCT_IDS.coca);
  });
  expect(calls).toHaveBeenCalledTimes(1);
  expect(calls).toHaveBeenCalledWith({
    barcode: '4006381333931',
    limit: 1,
    cursor: null,
  });
  await products.patchProduct(PRODUCT_IDS.coca, { barcode: null });
  await client.invalidateQueries({ queryKey: keys.products.all() });
  await act(async () => {
    expect(await result.current('4006381333931')).toBeNull();
  });
  expect(calls).toHaveBeenCalledTimes(2);
});

test('UPC-A scans also match an exact leading-zero EAN-13 catalog key', async () => {
  await products.patchProduct(PRODUCT_IDS.coca, { barcode: '0123456789012' });
  const client = createTestQueryClient();
  const { result } = await renderHook(() => useLookupBarcode(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    expect((await result.current('123456789012'))?.id).toBe(PRODUCT_IDS.coca);
  });
});
