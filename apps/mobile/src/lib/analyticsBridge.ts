import type { PostHog } from 'posthog-react-native';

type ExceptionProperties = Parameters<PostHog['captureException']>[1];

/** Non-React access for API transport, error reporting and feature checks. */
export interface AnalyticsBridge {
  getSessionId(): string | null;
  captureException(error: unknown, props?: ExceptionProperties): void;
  isFeatureEnabled(key: string): boolean | undefined;
}
let bridge: AnalyticsBridge | null = null;
export function setAnalyticsBridge(next: AnalyticsBridge | null): void {
  bridge = next;
}
export function analyticsSessionId(): string | null {
  return bridge?.getSessionId() ?? null;
}
export function captureException(
  error: unknown,
  props?: ExceptionProperties,
): void {
  bridge?.captureException(error, props);
}
export function isFeatureEnabled(key: string): boolean | undefined {
  return bridge?.isFeatureEnabled(key);
}
