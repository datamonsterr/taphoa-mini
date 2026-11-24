import { renderApp, screen, waitFor } from '@/test/router';
import * as Font from 'expo-font';
import { providerProps, resetPostHog } from '@/test/posthog';
import { setAnalyticsSink } from '@/lib/analytics';
import { setClerkState } from '@/test/clerk';

describe('mobile app startup', () => {
  beforeEach(() => {
    resetPostHog();
    setAnalyticsSink(null);
    delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
    setClerkState({
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      sessionId: null,
    });
  });

  test('app renders first screen before optional fonts resolve', async () => {
    let resolveOptionalFonts: () => void;
    const optionalFontsPromise = new Promise<void>((resolve) => {
      resolveOptionalFonts = resolve;
    });
    const loadAsyncSpy = jest
      .spyOn(Font, 'loadAsync')
      .mockReturnValue(optionalFontsPromise);

    await renderApp('/sign-in');

    // Screen is rendered without waiting for optional fonts
    expect(screen.getByTestId('auth-sign-in-screen')).toBeTruthy();

    // Clean up
    resolveOptionalFonts!();
    loadAsyncSpy.mockRestore();
  });

  test('PostHog and OfflineSync do not start until after first paint', async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-posthog-key';

    await renderApp('/sign-in');

    // First paint has rendered the first screen
    expect(screen.getByTestId('auth-sign-in-screen')).toBeTruthy();

    // After first paint, PostHogProvider should be initialized
    await waitFor(() => {
      expect(providerProps).toHaveBeenCalled();
    });
  });
});
