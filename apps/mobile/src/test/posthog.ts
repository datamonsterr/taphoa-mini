/** Shared fake used by the global PostHog mock. */
export const posthog = {
  capture: jest.fn(),
  screen: jest.fn(),
  identify: jest.fn(),
  group: jest.fn(),
  register: jest.fn(),
  unregister: jest.fn(),
  reset: jest.fn(),
  getSessionId: jest.fn<string | null, []>(() => null),
  captureException: jest.fn(),
  isFeatureEnabled: jest.fn<boolean | undefined, [string]>(),
  getFeatureFlag: jest.fn<boolean | string | undefined, [string]>((key) =>
    featureFlags.get(key),
  ),
  onFeatureFlags: jest.fn<() => void, [() => void]>(() => () => {}),
};
export const featureFlags = new Map<string, boolean>();
export const providerProps = jest.fn();
export function resetPostHog() {
  Object.values(posthog).forEach((method) => method.mockClear());
  posthog.getSessionId.mockReturnValue(null);
  posthog.isFeatureEnabled.mockReturnValue(undefined);
  posthog.getFeatureFlag.mockImplementation((key) => featureFlags.get(key));
  posthog.onFeatureFlags.mockImplementation(() => () => {});
  providerProps.mockClear();
  featureFlags.clear();
}
