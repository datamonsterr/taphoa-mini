import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { setApiTransport } from '@/lib/api/client';
import { createTestQueryClient } from '@/test/render';

import { useVoiceUtterance } from './api';
import { fixtureClip } from './fixture';
import { uploadClipsAsBlobs } from './testing';

beforeEach(uploadClipsAsBlobs);
afterEach(() => onlineManager.setOnline(true));

/** #156: a paused upload never settles, so the sheet stayed on "Đang hiểu…" forever offline. */
test('an upload started offline fails instead of waiting for the network', async () => {
  setApiTransport(async () => {
    throw new TypeError('Network request failed');
  });
  const qc = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = await renderHook(() => useVoiceUtterance(), { wrapper });
  await act(async () => onlineManager.setOnline(false));
  const clip = fixtureClip('two-line-sale.m4a');
  act(() => {
    result.current.mutate({
      clip,
      mode: 'sale',
      language: 'vi',
      entry: 'longpress',
      screen: 'voice',
    });
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isPaused).toBe(false);
});
