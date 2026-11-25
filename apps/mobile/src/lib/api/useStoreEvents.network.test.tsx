import { act, renderHook } from '@testing-library/react-native';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { useStoreEvents } from './useStoreEvents';

const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock('./clerkBridge', () => ({
  ...jest.requireActual('./clerkBridge'),
  clerkToken: jest.fn(async () => 'token'),
}));

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('offline cancels retries and online makes one new request', async () => {
  jest.useFakeTimers();
  onlineManager.setOnline(false);
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  mockFetch.mockReset().mockRejectedValue(new Error('network down'));
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = await renderHook(() => useStoreEvents('store'), { wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60000);
  });
  expect(mockFetch).not.toHaveBeenCalled();
  await act(async () => {
    onlineManager.setOnline(true);
    await flush();
  });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    onlineManager.setOnline(false);
    await jest.advanceTimersByTimeAsync(60000);
  });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    onlineManager.setOnline(true);
    await flush();
  });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  await hook.unmount();
  onlineManager.setOnline(true);
  jest.useRealTimers();
});
