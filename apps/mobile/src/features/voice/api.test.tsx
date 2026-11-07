import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { getApiClient, setApiTransport } from '@/lib/api/client';
import { registerAuthBridge } from '@/lib/api/clerkBridge';
import { createTestQueryClient } from '@/test/render';

import { uploadUtterance, useVoiceUtterance } from './api';
import { fixtureClip } from './fixture';
import { uploadClipsAsBlobs } from './testing';
import { initialVoiceSettings, useVoiceSettings } from './voiceSettings';

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

/** #163: the opt-in reaches the server with a sale clip, and only then. */
describe('donate flag', () => {
  async function sentDonate(
    mode: 'sale' | 'transcribe',
    donate: boolean,
  ): Promise<boolean | undefined> {
    const spy = jest
      .spyOn(getApiClient(), 'createVoiceUtterance')
      .mockResolvedValue({
        data: undefined,
        error: undefined,
        response: new Response(),
      } as never);
    registerAuthBridge({
      userId: 'user_test',
      getToken: async () => null,
      getStoreId: () => null,
      membershipRequired: () => {},
    });
    useVoiceSettings.getState().setDonate(donate);
    await uploadUtterance({
      clip: fixtureClip('two-line-sale.m4a'),
      mode,
      language: 'vi',
      entry: 'longpress',
      screen: 'voice',
    }).catch(() => undefined);
    const sent = spy.mock.calls[0]?.[0].donate;
    spy.mockRestore();
    return sent;
  }
  afterEach(() => useVoiceSettings.setState(initialVoiceSettings));

  test('a sale clip carries donate=true only when the switch is on', async () => {
    expect(await sentDonate('sale', true)).toBe(true);
    expect(await sentDonate('sale', false)).toBe(false);
  });

  test('only the person who opted in donates after account switches', async () => {
    const select = (userId: string) =>
      registerAuthBridge({
        userId,
        getToken: async () => null,
        getStoreId: () => null,
        membershipRequired: () => {},
      });
    const spy = jest
      .spyOn(getApiClient(), 'createVoiceUtterance')
      .mockResolvedValue({
        data: undefined,
        error: undefined,
        response: new Response(),
      } as never);
    const send = () =>
      uploadUtterance({
        clip: fixtureClip('two-line-sale.m4a'),
        mode: 'sale',
        language: 'vi',
        entry: 'longpress',
        screen: 'voice',
      }).catch(() => undefined);
    select('person-a');
    useVoiceSettings.getState().setDonate(true);
    await send();
    select('person-b');
    await send();
    select('person-a');
    await send();
    expect(spy.mock.calls.map(([request]) => request.donate)).toEqual([
      true,
      false,
      true,
    ]);
    spy.mockRestore();
  });

  test('a transcribe clip is never donated', async () => {
    expect(await sentDonate('transcribe', true)).toBe(false);
  });
});
