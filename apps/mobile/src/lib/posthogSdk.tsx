import Constants, { ExecutionEnvironment } from 'expo-constants';
import { PostHogProvider } from 'posthog-react-native';
import type { PropsWithChildren } from 'react';

export { usePostHog } from 'posthog-react-native';
export type { AnalyticsClient as PostHog } from './analyticsBridge';

export function AnalyticsSdkProvider({
  apiKey,
  host,
  children,
}: PropsWithChildren<{ apiKey: string; host: string }>) {
  return (
    <PostHogProvider
      apiKey={apiKey}
      options={{
        host: host,
        // The JS analytics SDK works in Expo Go; its native replay plugin does not.
        enableSessionReplay:
          Constants.executionEnvironment !== ExecutionEnvironment.StoreClient,
        sessionReplayConfig: {
          sampleRate:
            process.env.EXPO_PUBLIC_ENVIRONMENT === 'test' ? 1 : undefined,
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
      {children}
    </PostHogProvider>
  );
}
