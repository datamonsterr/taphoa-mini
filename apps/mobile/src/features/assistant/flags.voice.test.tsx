import { renderHook } from '@testing-library/react-native';

import { AnalyticsProvider } from '@/lib/analyticsPostHog';
import { featureFlags, resetPostHog } from '@/test/posthog';

import {
  useVoiceServerChat,
  VOICE_SERVER_CHAT_FLAG,
  voiceServerChatOverride,
} from './flags';

beforeEach(() => {
  resetPostHog();
  delete process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT;
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});
afterEach(() => {
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '0';
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});

test.each([
  ['1', true],
  ['true', true],
  ['TRUE', true],
  ['0', false],
  ['false', false],
  ['', undefined],
  ['maybe', undefined],
  [undefined, undefined],
])('override %p -> %p', (value, expected) => {
  if (value === undefined) delete process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT;
  else process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = value;
  expect(voiceServerChatOverride()).toBe(expected);
});

test('server chat is on by default, while PostHog is off or loading', async () => {
  expect((await renderHook(() => useVoiceServerChat())).result.current).toBe(
    true,
  );
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  expect(
    (
      await renderHook(() => useVoiceServerChat(), {
        wrapper: AnalyticsProvider,
      })
    ).result.current,
  ).toBe(true);
});

test('only an explicit remote false turns it off', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  featureFlags.set(VOICE_SERVER_CHAT_FLAG, false);
  expect(
    (
      await renderHook(() => useVoiceServerChat(), {
        wrapper: AnalyticsProvider,
      })
    ).result.current,
  ).toBe(false);
});

test('the env override beats the remote flag in both directions', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  featureFlags.set(VOICE_SERVER_CHAT_FLAG, false);
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '1';
  expect(
    (
      await renderHook(() => useVoiceServerChat(), {
        wrapper: AnalyticsProvider,
      })
    ).result.current,
  ).toBe(true);
  featureFlags.set(VOICE_SERVER_CHAT_FLAG, true);
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '0';
  expect(
    (
      await renderHook(() => useVoiceServerChat(), {
        wrapper: AnalyticsProvider,
      })
    ).result.current,
  ).toBe(false);
});
