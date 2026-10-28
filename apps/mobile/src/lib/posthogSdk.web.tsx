import browserPostHog, {
  type PostHog as WebPostHog,
  type PostHogConfig,
} from 'posthog-js';
import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import type { AnalyticsClient } from './analyticsBridge';
export type { AnalyticsClient as PostHog } from './analyticsBridge';

/** Web needs the browser recorder: posthog-react-native replay only supports iOS/Android. */
export function webPostHogConfig(host: string): Partial<PostHogConfig> {
  return {
    api_host: host,
    defaults: '2026-08-30',
    // The shared router hook emits the contract's sanitized $screen events.
    autocapture: false,
    // Browser automation sets navigator.webdriver; capture our test flows deliberately.
    opt_out_useragent_filter: process.env.EXPO_PUBLIC_ENVIRONMENT === 'test',
    capture_pageview: false,
    capture_pageleave: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_dead_clicks: false,
    enable_recording_console_log: false,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    disable_session_recording: false,
    session_recording: {
      sampleRate:
        process.env.EXPO_PUBLIC_ENVIRONMENT === 'test' ? 1 : undefined,
      maskAllInputs: true,
      maskTextSelector: '*',
      // Native PostHogMaskView does not block DOM media. Cover camera previews,
      // product images (including RN Web background images), and hidden/file inputs.
      blockSelector:
        '[data-ph-no-capture], img, video, canvas, svg image, [style*="background-image"], input[type="hidden"], input[type="file"]',
      maskAttributeFn: (name, value) =>
        /^(value|placeholder|title|alt|aria-label|href|data-.*)$/i.test(name)
          ? '*'.repeat(value.length)
          : value,
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        // Also applies to replay page URLs; queries/fragments may hold auth data.
        name: request.name?.split(/[?#]/)[0],
      }),
    },
  };
}

/** Keep product events, identity, flags, errors and API correlation on the replay's client. */
export function adaptWebPostHog(client: WebPostHog): AnalyticsClient {
  return {
    capture: (event, props) => {
      client.capture(event, props);
    },
    screen: async (name, props) => {
      client.capture('$screen', { ...props, $screen_name: name });
    },
    register: async (props) => {
      client.register(props);
    },
    unregister: async (property) => {
      client.unregister(property);
    },
    identify: (id, props) => {
      if (id) client.identify(id, props);
    },
    group: (type, key, props) => client.group(type, key, props),
    reset: () => client.reset(true),
    getSessionId: () => client.get_session_id(),
    captureException: (error, props) => {
      client.captureException(error, props);
    },
    isFeatureEnabled: (key) => client.isFeatureEnabled(key),
    getFeatureFlag: (key) => client.getFeatureFlag(key),
    onFeatureFlags: (callback) =>
      client.onFeatureFlags((_, flags) => callback(flags)),
  };
}

let browserClient: AnalyticsClient | null = null;
const readyListeners = new Set<() => void>();
const subscribeReady = (listener: () => void) => {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
};
const readClient = () => browserClient;
const serverClient = () => null;
const publishClient = () => {
  browserClient = adaptWebPostHog(browserPostHog);
  readyListeners.forEach((listener) => listener());
};

const ClientContext = createContext<AnalyticsClient | null>(null);
export function usePostHog(): AnalyticsClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('Analytics SDK provider is missing');
  return client;
}

export function AnalyticsSdkProvider({
  apiKey,
  host,
  children,
}: PropsWithChildren<{ apiKey: string; host: string }>) {
  const client = useSyncExternalStore(subscribeReady, readClient, serverClient);
  useEffect(() => {
    const options = webPostHogConfig(host);
    if (browserPostHog.__loaded) {
      // init() is a no-op after the first call. Resume after a provider remount
      // (including StrictMode) without losing the existing identity/session.
      browserPostHog.set_config(options);
      publishClient();
    } else {
      browserPostHog.init(apiKey, { ...options, loaded: publishClient });
    }
    return () => {
      browserPostHog.stopSessionRecording();
    };
  }, [apiKey, host]);
  // Initialize only in the browser, before registering shared properties/screens.
  return client ? (
    <ClientContext value={client}>{children}</ClientContext>
  ) : null;
}
