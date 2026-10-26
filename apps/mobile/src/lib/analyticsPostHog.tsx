import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { usePathname, useSegments } from 'expo-router';
import {
  PostHogProvider,
  useFeatureFlag,
  usePostHog,
  type PostHog,
} from 'posthog-react-native';
import { useEffect, useRef, type PropsWithChildren } from 'react';

import {
  setAnalyticsSink,
  type AnalyticsSink,
  type AppEventName,
  type AppEventProps,
} from './analytics';
import { setAnalyticsBridge } from './analyticsBridge';
import { useSettingsStore } from '@/stores/settings';

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
    setAnalyticsBridge({
      getSessionId: () => posthog.getSessionId(),
      captureException: (error, props) =>
        posthog.captureException(error, props),
      isFeatureEnabled: (key) => posthog.isFeatureEnabled(key),
    });
    return () => {
      setAnalyticsSink(null);
      setAnalyticsBridge(null);
    };
  }, [posthog]);
  useEffect(() => {
    const version = Constants.expoConfig?.version ?? '1.0.0';
    const build = Application.nativeBuildVersion;
    void posthog.register({
      environment: process.env.EXPO_PUBLIC_ENVIRONMENT || 'local',
      app_version: build ? `${version} (${build})` : version,
      language,
    });
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
  const posthog = usePostHog();
  const previous = useRef<string | null>(null);
  const { userId, email, name, storeId, storeName, memberId, role } =
    identity ?? {};
  const signedOut = identity === null;
  useEffect(() => {
    if (!process.env.EXPO_PUBLIC_POSTHOG_KEY || !posthog) return;
    if (signedOut) {
      if (previous.current !== null) {
        void posthog.unregister('member_id');
        void posthog.unregister('role');
        posthog.reset();
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

export const ASSISTANT_ENABLED_FLAG = 'assistant_enabled';
export function useAssistantEnabled(): boolean {
  const flag = useFeatureFlag(ASSISTANT_ENABLED_FLAG);
  return !process.env.EXPO_PUBLIC_POSTHOG_KEY || flag === undefined
    ? true
    : Boolean(flag);
}
