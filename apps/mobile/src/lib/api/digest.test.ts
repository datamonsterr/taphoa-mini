import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';

import { resetApiClient, setApiTransport } from './client';
import { getDigest } from './digest';
import { useDigest, useOpenDigest } from './hooks';
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

// Issue 203: the dashboard card reads without marking the digest read; only the digest screen
// opts in, and only then does the card refresh and lose its Mới badge.
test('reading for the card never marks the digest read; useOpenDigest does and refreshes the card', async () => {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const card = await renderHook(() => useDigest(), { wrapper });
  await waitFor(() => expect(card.result.current.isSuccess).toBe(true));
  expect(card.result.current.data?.read_at).toBeNull();
  // A second peek (a reload of the dashboard) still shows the digest as unread.
  await card.result.current.refetch();
  expect(card.result.current.data?.read_at).toBeNull();

  const screen = await renderHook(() => useOpenDigest(), { wrapper });
  await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
  // The response is the state before this open, so the first open still reads null ...
  expect(screen.result.current.data?.read_at).toBeNull();
  // ... and the card, refreshed by the open, now knows it was read.
  await waitFor(() => expect(card.result.current.data?.read_at).not.toBeNull());
});

test('getDigest sends mark_read only when asked', async () => {
  const digestBody = {
    business_date: '2026-10-26',
    generated_at: '2026-10-26T00:00:00Z',
    source: 'template',
    summary_vi: 'Hôm qua chưa có đơn nào.',
    sales: { revenue: 0, sale_count: 0, gross_profit: null, change_pct: null },
    restock: [],
    overdue_debts: { count: 0, total: 0 },
    open_drafts: { count: 0 },
    read_at: null,
  };
  const urls: string[] = [];
  setApiTransport((async (input: Request | string | URL) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(digestBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  await getDigest();
  await getDigest('2026-10-26');
  await getDigest(undefined, true);
  await getDigest('2026-10-26', true);
  expect(urls[0]).not.toContain('mark_read');
  expect(urls[1]).toContain('business_date=2026-10-26');
  expect(urls[1]).not.toContain('mark_read');
  expect(urls[2]).toContain('mark_read=true');
  expect(urls[3]).toMatch(/business_date=2026-10-26/);
  expect(urls[3]).toContain('mark_read=true');
});
