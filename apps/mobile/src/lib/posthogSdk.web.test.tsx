import { renderHook } from '@testing-library/react-native';
import browserPostHog from 'posthog-js';
import {
  adaptWebPostHog,
  AnalyticsSdkProvider,
  usePostHog,
  webPostHogConfig,
} from './posthogSdk.web';

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    __loaded: false,
    set_config: jest.fn(),
    init: jest.fn(),
    stopSessionRecording: jest.fn(),
    capture: jest.fn(),
    register: jest.fn(),
    unregister: jest.fn(),
    identify: jest.fn(),
    group: jest.fn(),
    reset: jest.fn(),
    get_session_id: jest.fn(() => 'web-replay-session'),
    captureException: jest.fn(),
    isFeatureEnabled: jest.fn(),
    getFeatureFlag: jest.fn(),
    onFeatureFlags: jest.fn(() => jest.fn()),
  },
}));
const sdk = jest.mocked(browserPostHog);
afterEach(() => {
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_ENVIRONMENT;
});

test('browser replay masks inputs/text/media and disables body, header and console recording', () => {
  process.env.EXPO_PUBLIC_ENVIRONMENT = 'test';
  const config = webPostHogConfig('https://us.i.posthog.com');
  expect(config).toMatchObject({
    api_host: 'https://us.i.posthog.com',
    opt_out_useragent_filter: true,
    disable_session_recording: false,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    enable_recording_console_log: false,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      recordHeaders: false,
      recordBody: false,
      sampleRate: 1,
    },
  });
  const replay = config.session_recording!;
  for (const selector of [
    'img',
    'video',
    'canvas',
    'svg image',
    '[style*="background-image"]',
    'input[type="hidden"]',
    'input[type="file"]',
  ]) {
    expect(replay.blockSelector!.split(', ')).toContain(selector);
  }
  expect(replay.maskAttributeFn!('value', 'secret')).toBe('******');
  expect(replay.maskAttributeFn!('aria-label', 'secret')).toBe('******');
  expect(replay.maskAttributeFn!('style', 'width: 20px')).toBe('width: 20px');
  expect(
    replay.maskCapturedNetworkRequestFn!({
      name: 'https://example.test/sign-in?token=secret#fragment',
      duration: 0,
      entryType: 'navigation',
      startTime: 0,
    }),
  ).toMatchObject({ name: 'https://example.test/sign-in' });
  delete process.env.EXPO_PUBLIC_ENVIRONMENT;
  expect(
    webPostHogConfig('host').session_recording!.sampleRate,
  ).toBeUndefined();
  expect(webPostHogConfig('host').opt_out_useragent_filter).toBe(false);
  // Production smoke exports run under Playwright and must not be dropped as bots.
  process.env.EXPO_PUBLIC_SMOKE = '1';
  try {
    expect(webPostHogConfig('host').opt_out_useragent_filter).toBe(true);
  } finally {
    delete process.env.EXPO_PUBLIC_SMOKE;
  }
});

test('adapter uses the browser replay session for events, identities, flags and API correlation', async () => {
  const client = adaptWebPostHog(browserPostHog);
  expect(client.getSessionId()).toBe('web-replay-session');
  client.capture('signed_in', { method: 'google' });
  await client.screen('/product/[id]');
  expect(sdk.capture).toHaveBeenLastCalledWith('$screen', {
    $screen_name: '/product/[id]',
  });
  await client.register({ environment: 'test' });
  expect(sdk.register).toHaveBeenCalledWith({ environment: 'test' });
  await client.unregister('member_id');
  expect(sdk.unregister).toHaveBeenCalledWith('member_id');
  client.identify('user', { role: 'lead' });
  expect(sdk.identify).toHaveBeenCalledWith('user', { role: 'lead' });
  client.group('store', 'shop', { name: 'Shop' });
  expect(sdk.group).toHaveBeenCalledWith('store', 'shop', { name: 'Shop' });
  const error = new Error('probe');
  client.captureException(error, { code: 'probe' });
  expect(sdk.captureException).toHaveBeenCalledWith(error, { code: 'probe' });
  const notify = jest.fn();
  const unsubscribe = client.onFeatureFlags(notify);
  const callback = sdk.onFeatureFlags.mock.calls[0][0];
  callback(['assistant_enabled'], { assistant_enabled: false });
  expect(notify).toHaveBeenCalledWith({ assistant_enabled: false });
  sdk.getFeatureFlag.mockReturnValue(false);
  expect(client.getFeatureFlag('assistant_enabled')).toBe(false);
  sdk.isFeatureEnabled.mockReturnValue(false);
  expect(client.isFeatureEnabled('assistant_enabled')).toBe(false);
  unsubscribe();
  client.reset();
  expect(sdk.reset).toHaveBeenCalledWith(true);
});

test('web provider initializes one browser client and stops recording on unmount', async () => {
  sdk.init.mockImplementation((_, config) => {
    config?.loaded?.(browserPostHog);
    return browserPostHog;
  });
  const hook = await renderHook(() => usePostHog(), {
    wrapper: ({ children }) => (
      <AnalyticsSdkProvider apiKey="test-key" host="https://us.i.posthog.com">
        {children}
      </AnalyticsSdkProvider>
    ),
  });
  expect(sdk.init).toHaveBeenCalledTimes(1);
  expect(hook.result.current.getSessionId()).toBe('web-replay-session');
  await hook.unmount();
  expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(1);
});

test('a remounted provider resumes the initialized recorder without reinitializing the SDK', async () => {
  const loaded = jest.replaceProperty(browserPostHog, '__loaded', true);
  try {
    const hook = await renderHook(() => usePostHog(), {
      wrapper: ({ children }) => (
        <AnalyticsSdkProvider apiKey="test-key" host="https://us.i.posthog.com">
          {children}
        </AnalyticsSdkProvider>
      ),
    });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.set_config).toHaveBeenCalledWith(
      expect.objectContaining({ disable_session_recording: false }),
    );
    expect(hook.result.current.getSessionId()).toBe('web-replay-session');
    await hook.unmount();
  } finally {
    loaded.restore();
  }
});
