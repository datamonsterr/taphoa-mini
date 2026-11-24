import { act, renderHook } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createTestQueryClient } from '@/test/render';
import { PRODUCT_IDS, resetMockDb } from '@/test/mock';
import * as products from './products';
import { useLookupBarcode } from './hooks';
import { keys } from './keys';
import * as online from '@/lib/online';

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
  const calls = jest.spyOn(products, 'listProducts');
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
  expect(calls).toHaveBeenCalledTimes(1);
});

test('offline scans resolve the synced catalog including unit codes and report unknown codes', async () => {
  const product = await products.patchProduct(PRODUCT_IDS.coca, {
    barcode: '0123456789012',
  });
  const cached = {
    ...product,
    units: [
      {
        id: 'unit',
        name: 'pack',
        quantity_in_base: 6,
        price: 60000,
        barcode: '12345678',
      },
    ],
  };
  const client = createTestQueryClient();
  client.setQueryData(keys.catalog(), {
    cursor: 'synced',
    products: {
      [cached.id]: cached,
      archived: {
        ...cached,
        id: 'archived',
        barcode: '87654321',
        units: [],
        archived: true,
      },
    },
  });
  jest.spyOn(online, 'useOnline').mockReturnValue(false);
  const calls = jest
    .spyOn(products, 'listProducts')
    .mockRejectedValue(new Error('offline'));
  const { result } = await renderHook(() => useLookupBarcode(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    expect((await result.current('123456789012'))?.id).toBe(cached.id);
    expect((await result.current('12345678'))?.id).toBe(cached.id);
    expect(await result.current('87654321')).toBeNull();
  });
  expect(calls).not.toHaveBeenCalled();
});

test('offline lookup rejects ambiguous legacy codes', async () => {
  const product = await products.getProduct(PRODUCT_IDS.coca);
  const client = createTestQueryClient();
  client.setQueryData(keys.catalog(), {
    cursor: 'synced',
    products: {
      alias: { ...product, id: 'alias', barcode: '0123456789012' },
      exact: { ...product, id: 'exact', barcode: '123456789012' },
    },
  });
  jest.spyOn(online, 'useOnline').mockReturnValue(false);
  const { result } = await renderHook(() => useLookupBarcode(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await expect(result.current('123456789012')).rejects.toThrow(
      'barcode already used',
    );
  });
});

test('barcode normalization leaves non-digit strings unchanged', () => {
  expect(products.canonicalBarcode('0abcdefgh1234')).toBe('0abcdefgh1234');
  expect(products.canonicalBarcode('0123456789012')).toBe('123456789012');
});
