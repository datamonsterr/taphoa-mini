import { act, renderHook } from '@testing-library/react-native';
import type { Product } from '@/lib/api';
import { useBarcodeScanner } from './useBarcodeScanner';

const event = { data: '4006381333931', type: 'ean13' };
const product = { id: 'known' } as Product;

afterEach(() => jest.restoreAllMocks());

test('serializes lookups and ignores the same code for 2 seconds', async () => {
  let now = 10000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  let finish!: (product: Product | null) => void;
  const lookup = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(product);
  const onResult = jest.fn();
  const { result } = await renderHook(() =>
    useBarcodeScanner({ enabled: true, lookup, onResult, onError: jest.fn() }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.scan(event);
  });
  await act(async () => {
    await result.current.scan({ ...event, data: '8931234567890' });
  });
  expect(lookup).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(product);
    await pending;
  });
  now += 1999;
  await act(async () => {
    await result.current.scan(event);
  });
  expect(lookup).toHaveBeenCalledTimes(1);
  now += 1;
  await act(async () => {
    await result.current.scan(event);
  });
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(onResult).toHaveBeenCalledWith(event.data, product);
});

test('paused handler ignores events; pending result is discarded when a sheet opens', async () => {
  let finish!: (product: Product | null) => void;
  const lookup = jest.fn(
    () =>
      new Promise<Product | null>((resolve) => {
        finish = resolve;
      }),
  );
  const onResult = jest.fn();
  const { result, rerender } = await renderHook<
    ReturnType<typeof useBarcodeScanner>,
    { enabled: boolean }
  >(
    ({ enabled }) =>
      useBarcodeScanner({ enabled, lookup, onResult, onError: jest.fn() }),
    { initialProps: { enabled: false } },
  );
  await act(async () => {
    await result.current.scan(event);
  });
  expect(lookup).not.toHaveBeenCalled();
  await rerender({ enabled: true });
  const queuedHandler = result.current.scan;
  await rerender({ enabled: false });
  await act(async () => {
    await queuedHandler(event);
  });
  expect(lookup).not.toHaveBeenCalled();
  await rerender({ enabled: true });
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.scan(event);
  });
  await rerender({ enabled: false });
  await act(async () => {
    finish(product);
    await pending;
  });
  expect(onResult).not.toHaveBeenCalled();
});

test('unknown and network failure stay distinct; malformed reads never lookup', async () => {
  const lookup = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('offline'));
  const onResult = jest.fn();
  const onError = jest.fn();
  const { result } = await renderHook(() =>
    useBarcodeScanner({ enabled: true, lookup, onResult, onError }),
  );
  await act(async () => {
    await result.current.scan({ ...event, data: '123' });
    await result.current.scan(event);
  });
  expect(onResult).toHaveBeenCalledWith(event.data, null);
  await act(async () => {
    await result.current.scan({ ...event, data: '8931234567890' });
  });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onResult).toHaveBeenCalledTimes(1);
});
