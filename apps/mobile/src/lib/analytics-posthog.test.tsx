import { act, render, renderHook } from '@testing-library/react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Application from 'expo-application';
import { Text } from 'react-native';
import { capture, setAnalyticsSink, type AppEventProps } from './analytics';
import {
  AnalyticsProvider,
  PostHogSink,
  useAnalyticsIdentity,
  useAssistantEnabled,
} from './analyticsPostHog';
import {
  analyticsSessionId,
  captureException,
  isFeatureEnabled,
} from './analyticsBridge';
import {
  featureFlags,
  posthog,
  providerProps,
  resetPostHog,
} from '@/test/posthog';
import { useSettingsStore } from '@/stores/settings';

let mockPathname = '/product/123';
let mockSegments = ['product', '[id]'];
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useSegments: () => mockSegments,
}));

beforeEach(() => {
  resetPostHog();
  setAnalyticsSink(null);
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
  delete process.env.EXPO_PUBLIC_POSTHOG_HOST;
  delete process.env.EXPO_PUBLIC_ENVIRONMENT;
  delete process.env.EXPO_PUBLIC_SMOKE;
  mockPathname = '/product/123';
  mockSegments = ['product', '[id]'];
  useSettingsStore.setState({ language: 'vi' });
});

test('smoke builds tag app events and preserve the tag after sign-out', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  process.env.EXPO_PUBLIC_SMOKE = '1';
  const hook = await renderHook(
    ({ value }: { value: Parameters<typeof useAnalyticsIdentity>[0] }) =>
      useAnalyticsIdentity(value),
    {
      initialProps: { value: { userId: 'smoke-user', storeId: 'smoke-store' } },
      wrapper: AnalyticsProvider,
    },
  );
  expect(posthog.register).toHaveBeenCalledWith(
    expect.objectContaining({ smoke: true }),
  );
  await hook.rerender({ value: null });
  expect(posthog.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ smoke: true }),
  );
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});

const samples = {
  $screen: { $screen_name: '/product/[id]' },
  signed_in: { method: 'email_code' },
  signed_out: { method: 'google' },
  account_switched: { with_pin: true },
  assistant_opened: { entry: 'button' },
  assistant_message_sent: { input: 'text', thread_turn: 1 },
  assistant_reply_received: {
    latency_ms: 100,
    tools_count: 1,
    error_code: null,
  },
  assistant_feedback_given: { rating: 'up' },
  next_step_shown: { kind: 'setup', position: 0 },
  next_step_tapped: { kind: 'restock', position: 1 },
  digest_opened: { entry: 'card' },
  voice_input_used: { duration_ms: 1000, language: 'vi-VN', ok: true },
} satisfies AppEventProps;
const requiredKeys: Record<keyof AppEventProps, string[]> = {
  $screen: ['$screen_name'],
  signed_in: ['method'],
  signed_out: ['method'],
  account_switched: ['with_pin'],
  assistant_opened: ['entry'],
  assistant_message_sent: ['input', 'thread_turn'],
  assistant_reply_received: ['latency_ms', 'tools_count', 'error_code'],
  assistant_feedback_given: ['rating'],
  next_step_shown: ['kind', 'position'],
  next_step_tapped: ['kind', 'position'],
  digest_opened: ['entry'],
  voice_input_used: ['duration_ms', 'language', 'ok'],
};
// $screen_name is the contract's reserved screen property, not a person's name.
function assertSafe(value: unknown) {
  if (value && typeof value === 'object')
    Object.entries(value).forEach(([key, child]) => {
      if (key !== '$screen_name')
        expect(key).not.toMatch(
          /name|email|phone|bank|token|ocr_text|customer_name/i,
        );
      assertSafe(child);
    });
}
test.each(Object.keys(samples) as (keyof AppEventProps)[])(
  'forwards only the contract properties for %s',
  (name) => {
    setAnalyticsSink(new PostHogSink(posthog));
    capture(name, samples[name]);
    expect(posthog.capture).toHaveBeenCalledWith(name, samples[name]);
    expect(Object.keys(posthog.capture.mock.calls[0][1]).sort()).toEqual(
      [...requiredKeys[name]].sort(),
    );
    assertSafe(samples[name]);
  },
);

test('without a key renders children and leaves capture and bridge off', async () => {
  const view = await render(
    <AnalyticsProvider>
      <Text>child</Text>
    </AnalyticsProvider>,
  );
  expect(view.getByText('child')).toBeTruthy();
  capture('signed_out', { method: 'google' });
  expect(providerProps).not.toHaveBeenCalled();
  expect(posthog.capture).not.toHaveBeenCalled();
  expect(analyticsSessionId()).toBeNull();
  expect(isFeatureEnabled('flag')).toBeUndefined();
  captureException(new Error('off'));
  expect(posthog.captureException).not.toHaveBeenCalled();
});

test('Expo Go keeps analytics but never enables the native replay plugin', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const environment = jest.replaceProperty(
    Constants,
    'executionEnvironment',
    ExecutionEnvironment.StoreClient,
  );
  try {
    const view = await render(
      <AnalyticsProvider>
        <Text>child</Text>
      </AnalyticsProvider>,
    );
    expect(view.getByText('child')).toBeTruthy();
    expect(providerProps.mock.calls[0][0].options.enableSessionReplay).toBe(
      false,
    );
    capture('signed_out', { method: 'google' });
    expect(posthog.capture).toHaveBeenCalledWith('signed_out', {
      method: 'google',
    });
    await view.unmount();
  } finally {
    environment.restore();
  }
});

test('test native builds record every session with masking enabled', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  process.env.EXPO_PUBLIC_ENVIRONMENT = 'test';
  const view = await render(
    <AnalyticsProvider>
      <Text>child</Text>
    </AnalyticsProvider>,
  );
  expect(
    providerProps.mock.calls[0][0].options.sessionReplayConfig,
  ).toMatchObject({
    sampleRate: 1,
    maskAllTextInputs: true,
    maskAllImages: true,
    maskAllSandboxedViews: true,
  });
  await view.unmount();
});

test('provider configures privacy, registers properties and clears sink and bridge on unmount', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const view = await render(
    <AnalyticsProvider>
      <Text>child</Text>
    </AnalyticsProvider>,
  );
  expect(providerProps.mock.calls[0][0]).toMatchObject({
    apiKey: 'test-key',
    autocapture: { captureScreens: false, captureTouches: false },
    options: {
      host: 'https://us.i.posthog.com',
      enableSessionReplay: true,
      sessionReplayConfig: {
        maskAllTextInputs: true,
        maskAllImages: true,
        maskAllSandboxedViews: true,
        captureLog: false,
        captureNetworkTelemetry: false,
      },
      errorTracking: {
        autocapture: {
          uncaughtExceptions: true,
          unhandledRejections: true,
          console: [],
        },
      },
      captureAppLifecycleEvents: true,
    },
  });
  expect(posthog.register).toHaveBeenCalledWith({
    environment: 'local',
    app_version: `${Constants.expoConfig?.version ?? '1.0.0'} (123)`,
    language: 'vi',
  });
  await act(() => useSettingsStore.getState().setLanguage('en'));
  expect(posthog.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ language: 'en' }),
  );
  capture('signed_in', { method: 'google' });
  expect(posthog.capture).toHaveBeenCalledTimes(1);
  posthog.getSessionId.mockReturnValue('session');
  expect(analyticsSessionId()).toBe('session');
  const error = new Error('test');
  captureException(error, { code: 'test' });
  expect(posthog.captureException).toHaveBeenCalledWith(error, {
    code: 'test',
  });
  posthog.isFeatureEnabled.mockReturnValue(false);
  expect(isFeatureEnabled('flag')).toBe(false);
  await view.unmount();
  capture('signed_in', { method: 'google' });
  expect(posthog.capture).toHaveBeenCalledTimes(1);
  expect(analyticsSessionId()).toBeNull();
});

test('tracks route templates on pathname change only', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const view = await render(
    <AnalyticsProvider>
      <Text>child</Text>
    </AnalyticsProvider>,
  );
  expect(posthog.screen).toHaveBeenLastCalledWith('/product/[id]');
  await view.rerender(
    <AnalyticsProvider>
      <Text>again</Text>
    </AnalyticsProvider>,
  );
  expect(posthog.screen).toHaveBeenCalledTimes(1);
  mockPathname = '/product/456';
  await view.rerender(
    <AnalyticsProvider>
      <Text>again</Text>
    </AnalyticsProvider>,
  );
  expect(posthog.screen).toHaveBeenCalledTimes(2);
  mockPathname = '/stock';
  mockSegments = ['(shop)', 'stock'];
  await view.rerender(
    <AnalyticsProvider>
      <Text>again</Text>
    </AnalyticsProvider>,
  );
  expect(posthog.screen).toHaveBeenLastCalledWith('/stock');
});

test('identity is idempotent, omits absent person properties and resets on sign-out', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const identity = {
    userId: 'user',
    storeId: 'store',
    storeName: 'Shop',
    memberId: 'member',
    role: 'lead' as const,
    email: 'owner@example.test',
    name: 'Owner',
  };
  const hook = await renderHook(
    ({ value }: { value: Parameters<typeof useAnalyticsIdentity>[0] }) =>
      useAnalyticsIdentity(value),
    { initialProps: { value: identity }, wrapper: AnalyticsProvider },
  );
  expect(posthog.identify).toHaveBeenCalledWith('user', {
    email: identity.email,
    name: 'Owner',
    role: 'lead',
  });
  expect(posthog.group).toHaveBeenCalledWith('store', 'store', {
    name: 'Shop',
  });
  expect(posthog.register).toHaveBeenCalledWith({
    member_id: 'member',
    role: 'lead',
  });
  await hook.rerender({ value: { ...identity } });
  expect(posthog.identify).toHaveBeenCalledTimes(1);
  await hook.rerender({ value: null });
  expect(posthog.unregister.mock.calls).toEqual([['member_id'], ['role']]);
  expect(posthog.reset).toHaveBeenCalledTimes(1);
  // The common super properties survive the reset.
  expect(posthog.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ environment: 'local', language: 'vi' }),
  );
  await hook.rerender({ value: null });
  expect(posthog.reset).toHaveBeenCalledTimes(1);
});

test('incomplete identity is ignored and absent properties are omitted', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  const hook = await renderHook(
    ({ value }: { value: Parameters<typeof useAnalyticsIdentity>[0] }) =>
      useAnalyticsIdentity(value),
    {
      initialProps: { value: { userId: 'u', storeId: null } },
      wrapper: AnalyticsProvider,
    },
  );
  expect(posthog.identify).not.toHaveBeenCalled();
  await hook.rerender({ value: { userId: 'u', storeId: 's', email: null } });
  expect(posthog.identify).toHaveBeenCalledWith('u', {});
  expect(posthog.group).toHaveBeenCalledWith('store', 's', {});
  expect(posthog.register).toHaveBeenCalledWith({});
});

test.each([undefined, true, false])(
  'assistant flag fails open while loading: %s',
  async (flag) => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
    if (flag !== undefined) featureFlags.set('assistant_enabled', flag);
    const hook = await renderHook(useAssistantEnabled, {
      wrapper: AnalyticsProvider,
    });
    expect(hook.result.current).toBe(flag ?? true);
    expect(posthog.onFeatureFlags).toHaveBeenCalled();
  },
);
test('assistant is enabled when PostHog is off even with a stale disabled flag', async () => {
  featureFlags.set('assistant_enabled', false);
  const hook = await renderHook(useAssistantEnabled, {
    wrapper: AnalyticsProvider,
  });
  expect(hook.result.current).toBe(true);
  expect(posthog.onFeatureFlags).not.toHaveBeenCalled();
});

test('string flag values only turn the assistant off when they say false', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  posthog.getFeatureFlag.mockReturnValue('false');
  const off = await renderHook(useAssistantEnabled, {
    wrapper: AnalyticsProvider,
  });
  expect(off.result.current).toBe(false);
  posthog.getFeatureFlag.mockReturnValue('control');
  const on = await renderHook(useAssistantEnabled, {
    wrapper: AnalyticsProvider,
  });
  expect(on.result.current).toBe(true);
});

test('a flag change notifies the assistant switch', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  let notify: (() => void) | undefined;
  posthog.onFeatureFlags.mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  const hook = await renderHook(useAssistantEnabled, {
    wrapper: AnalyticsProvider,
  });
  expect(hook.result.current).toBe(true);
  featureFlags.set('assistant_enabled', false);
  await act(async () => notify?.());
  expect(hook.result.current).toBe(false);
});

test('uses configured host and environment, with no native build version', async () => {
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://analytics.example.test';
  process.env.EXPO_PUBLIC_ENVIRONMENT = 'test';
  const build = jest.replaceProperty(Application, 'nativeBuildVersion', null);
  try {
    await render(
      <AnalyticsProvider>
        <Text>child</Text>
      </AnalyticsProvider>,
    );
    expect(providerProps.mock.calls[0][0].options.host).toBe(
      'https://analytics.example.test',
    );
    expect(posthog.register).toHaveBeenCalledWith({
      environment: 'test',
      app_version: Constants.expoConfig?.version ?? '1.0.0',
      language: 'vi',
    });
  } finally {
    build.restore();
  }
});

test('identity has no effect when analytics is off', async () => {
  await renderHook(() => useAnalyticsIdentity({ userId: 'u', storeId: 's' }));
  expect(posthog.identify).not.toHaveBeenCalled();
});
