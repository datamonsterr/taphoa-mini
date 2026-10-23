import { act, renderHook } from '@testing-library/react-native';

import { useDebouncedValue } from './useDebouncedValue';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('returns the initial value at once and the latest one after the delay', async () => {
  const { result, rerender } = await renderHook(
    ({ value }: { value: string }) => useDebouncedValue(value, 250),
    { initialProps: { value: 'a' } },
  );
  expect(result.current).toBe('a');

  await rerender({ value: 'ab' });
  await rerender({ value: 'abc' });
  expect(result.current).toBe('a');

  await act(async () => {
    jest.advanceTimersByTime(249);
  });
  expect(result.current).toBe('a');

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(result.current).toBe('abc');
});
