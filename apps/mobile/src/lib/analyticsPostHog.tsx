import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { usePathname, useSegments } from 'expo-router';
import {
  PostHogProvider,
  usePostHog,
  type PostHog,
} from 'posthog-react-native';
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import {
  setAnalyticsSink,
  type AnalyticsSink,
  type AppEventName,
  type AppEventProps,
} from './analytics';
import { setAnalyticsClient, useAnalyticsClient } from './analyticsBridge';
import { useSettingsStore } from '@/stores/settings';

/** Super properties every app event carries; registered on mount, language change and after a reset. */
export function commonProperties(language: string) {
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const build = Application.nativeBuildVersion;
  return {
    environment: process.env.EXPO_PUBLIC_ENVIRONMENT || 'local',
    app_version: build ? `${version} (${build})` : version,
    language,
  };
}

export class PostHogSink implements AnalyticsSink {
  constructor(private readonly posthog: Pick<PostHog, 'capture'>) {}
  capture<E extends AppEventName>(event: E, props: AppEventProps[E]): void {
    this.posthog.capture(event, props);
  }
}

export function useScreenTracking(): void {
  const posthog = usePostHog();
  const pathname = usePathname();
  const segments = useSegments();
  // Router segments retain parameter names and omit all query values. Route groups
  // do not form part of the visible path.
  const screenName =
    '/' + segments.filter((segment) => !segment.startsWith('(')).join('/');
  useEffect(() => {
    posthog.screen(screenName);
  }, [posthog, pathname, screenName]);
}

function AnalyticsRegistration({ children }: PropsWithChildren) {
  const posthog = usePostHog();
  const language = useSettingsStore((state) => state.language);
  useEffect(() => {
    setAnalyticsSink(new PostHogSink(posthog));
    setAnalyticsClient(posthog);
    return () => {
      setAnalyticsSink(null);
      setAnalyticsClient(null);
    };
  }, [posthog]);
  useEffect(() => {
    void posthog.register(commonProperties(language));
  }, [posthog, language]);
  useScreenTracking();
  return children;
}

export function AnalyticsProvider({ children }: PropsWithChildren) {
  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return children;
  return (
    <PostHogProvider
      apiKey={apiKey}
      options={{
        host:
          process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
        // The JS analytics SDK works in Expo Go; its native replay plugin does not.
        enableSessionReplay:
          Constants.executionEnvironment !== ExecutionEnvironment.StoreClient,
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
      }}
      autocapture={{ captureScreens: false, captureTouches: false }}
    >
      <AnalyticsRegistration>{children}</AnalyticsRegistration>
    </PostHogProvider>
  );
}

export interface AnalyticsIdentity {
  userId: string | null;
  email?: string | null;
  name?: string | null;
  storeId?: string | null;
  storeName?: string | null;
  memberId?: string | null;
  role?: 'lead' | 'seller' | null;
}

/** Pure identity plumbing; the auth controller supplies identity after X1 lands. */
export function useAnalyticsIdentity(identity: AnalyticsIdentity | null): void {
  const posthog = useAnalyticsClient();
  const previous = useRef<string | null>(null);
  const { userId, email, name, storeId, storeName, memberId, role } =
    identity ?? {};
  const signedOut = identity === null;
  useEffect(() => {
    if (!posthog) return;
    if (signedOut) {
      if (previous.current !== null) {
        void posthog.unregister('member_id');
        void posthog.unregister('role');
        // reset() also clears super properties; the common ones must survive sign-out.
        posthog.reset();
        void posthog.register(
          commonProperties(useSettingsStore.getState().language),
        );
        previous.current = null;
      }
      return;
    }
    if (!userId || !storeId) return;
    const key = JSON.stringify([
      userId,
      email,
      name,
      storeId,
      storeName,
      memberId,
      role,
    ]);
    if (previous.current === key) return;
    posthog.identify(userId, {
      ...(email != null ? { email } : {}),
      ...(name != null ? { name } : {}),
      ...(role != null ? { role } : {}),
    });
    posthog.group(
      'store',
      storeId,
      storeName != null ? { name: storeName } : {},
    );
    void posthog.register({
      ...(memberId != null ? { member_id: memberId } : {}),
      ...(role != null ? { role } : {}),
    });
    previous.current = key;
  }, [
    posthog,
    signedOut,
    userId,
    email,
    name,
    storeId,
    storeName,
    memberId,
    role,
  ]);
}

/**
 * A default-on PostHog flag. Fails open: `true` while PostHog is off, not mounted yet or still
 * loading flags, so only an explicit remote `false` turns the feature off.
 */
export function useDefaultOnFlag(key: string): boolean {
  const client = useAnalyticsClient();
  const subscribe = useCallback(
    (notify: () => void) => client?.onFeatureFlags(notify) ?? (() => {}),
    [client],
  );
  const read = useCallback(() => client?.getFeatureFlag(key), [client, key]);
  const flag = useSyncExternalStore(subscribe, read, () => undefined);
  // Only an explicit remote "off" switches it off; variants and loading fail open.
  return flag !== false && flag !== 'false';
}

export const ASSISTANT_ENABLED_FLAG = 'assistant_enabled';
/** The `assistant_enabled` kill switch (see {@link useDefaultOnFlag}). */
export function useAssistantEnabled(): boolean {
  return useDefaultOnFlag(ASSISTANT_ENABLED_FLAG);
}

export const VOICE_SERVER_CHAT_FLAG = 'voice_server_chat';
