import type { PostHog } from 'posthog-react-native';
import { useSyncExternalStore } from 'react';

export type AnalyticsClient = Pick<
  PostHog,
  | 'capture'
  | 'screen'
  | 'register'
  | 'unregister'
  | 'identify'
  | 'group'
  | 'reset'
  | 'getSessionId'
  | 'captureException'
  | 'getFeatureFlag'
  | 'onFeatureFlags'
> & { isFeatureEnabled(key: string): boolean | undefined };

type ExceptionProperties = Parameters<PostHog['captureException']>[1];

/**
 * Non-React access to the PostHog client for the API transport, error reporting and feature
 * checks, plus a subscription so hooks outside `PostHogProvider` never call the SDK's own hooks
 * (those log an error when no provider is mounted, which the web e2e suite treats as a crash).
 */
let client: AnalyticsClient | null = null;
const listeners = new Set<() => void>();

export function setAnalyticsClient(next: AnalyticsClient | null): void {
  client = next;
  listeners.forEach((listener) => listener());
}
export const subscribeAnalyticsClient = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const analyticsClient = (): AnalyticsClient | null => client;
const serverAnalyticsClient = (): AnalyticsClient | null => null;

/** The registered client, or null while analytics is off or not mounted yet. */
export function useAnalyticsClient(): AnalyticsClient | null {
  return useSyncExternalStore(
    subscribeAnalyticsClient,
    analyticsClient,
    serverAnalyticsClient,
  );
}

export function analyticsSessionId(): string | null {
  return client?.getSessionId() ?? null;
}
export function captureException(
  error: unknown,
  props?: ExceptionProperties,
): void {
  client?.captureException(error, props);
}
export function isFeatureEnabled(key: string): boolean | undefined {
  return client?.isFeatureEnabled(key);
}
