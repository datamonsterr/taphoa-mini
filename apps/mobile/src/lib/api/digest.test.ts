import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';

import { resetApiClient, setApiTransport } from './client';
import { getDigest } from './digest';
import { useDigest } from './hooks';
import { resetMockDb } from '@/test/mock';
import { createTestQueryClient } from '@/test/render';
import { ApiError } from './errors';

beforeEach(() => {
  resetMockDb();
  resetApiClient();
});

test('getDigest fetches digest with or without business_date', async () => {
  const digest = await getDigest();
  expect(digest.sales.revenue).toBe(1234000);
  expect(digest.source).toBe('template');

  await expect(getDigest('2000-01-01')).rejects.toThrow(ApiError);
});

test('useDigest hook returns digest data and handles 404 by returning null', async () => {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const { result } = await renderHook(() => useDigest(), { wrapper });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).not.toBeNull();
  expect(result.current.data?.sales.revenue).toBe(1234000);

  // For a missing business date (404), useDigest returns null instead of throwing an error
  const { result: notFoundResult } = await renderHook(
    () => useDigest('2000-01-01'),
    { wrapper },
  );

  await waitFor(() => expect(notFoundResult.current.isSuccess).toBe(true));
  expect(notFoundResult.current.data).toBeNull();
  expect(notFoundResult.current.isError).toBe(false);
});

test('useDigest hook propagates non-404 errors', async () => {
  setApiTransport(
    (async () =>
      new Response(JSON.stringify({ error: 'Server exploded' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
  );

  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const { result } = await renderHook(() => useDigest(), { wrapper });

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBeInstanceOf(ApiError);
  expect((result.current.error as ApiError).status).toBe(500);
});
