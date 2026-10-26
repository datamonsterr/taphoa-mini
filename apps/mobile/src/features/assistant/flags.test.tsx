import { renderHook } from '@testing-library/react-native';

import { AnalyticsProvider } from '@/lib/analyticsPostHog';
import { featureFlags, resetPostHog } from '@/test/posthog';

import { ASSISTANT_ENABLED_FLAG, useAssistantEnabled } from './flags';

beforeEach(() => {
  resetPostHog();
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});

test('assistant is enabled while PostHog is off or the flag is still loading', async () => {
  const off = await renderHook(() => useAssistantEnabled());
  expect(off.result.current).toBe(true);
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const loading = await renderHook(() => useAssistantEnabled(), {
    wrapper: AnalyticsProvider,
  });
  expect(loading.result.current).toBe(true);
});

test('the remote kill switch turns the assistant off', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  featureFlags.set(ASSISTANT_ENABLED_FLAG, false);
  const { result } = await renderHook(() => useAssistantEnabled(), {
    wrapper: AnalyticsProvider,
  });
  expect(result.current).toBe(false);
});
