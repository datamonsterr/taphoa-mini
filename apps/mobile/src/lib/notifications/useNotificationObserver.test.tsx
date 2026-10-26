import { renderHook, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { useNotificationObserver } from './useNotificationObserver';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
  },
}));

describe('useNotificationObserver', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue(
      null,
    );
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  test('initial response routes once and clears', async () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue({
      notification: {
        date: Date.now(),
        request: {
          identifier: 'n1',
          content: {
            title: 'Tóm tắt sáng nay',
            body: 'Doanh thu hôm qua...',
            data: { url: '/digest?entry=push' },
          },
          trigger: null,
        },
      },
      actionIdentifier: 'default',
    });

    await renderHook(() => useNotificationObserver());

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith('/digest?entry=push');
      expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  test('listener routes and clears on received response', async () => {
    let capturedListener: ((response: any) => void) | undefined;
    const removeMock = jest.fn();
    (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mockImplementation((listener) => {
      capturedListener = listener;
      return { remove: removeMock };
    });

    const hook = await renderHook(() => useNotificationObserver());

    await waitFor(() => {
      expect(capturedListener).toBeDefined();
    });

    // Trigger the response listener
    capturedListener!({
      notification: {
        date: Date.now(),
        request: {
          identifier: 'n2',
          content: {
            title: 'Tóm tắt sáng nay',
            body: '...',
            data: { url: '/assistant' },
          },
          trigger: null,
        },
      },
      actionIdentifier: 'default',
    });

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith('/assistant');
      expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(
        1,
      );
    });

    await hook.unmount();
    expect(removeMock).toHaveBeenCalled();
  });

  test('non-string or external url is ignored', async () => {
    let capturedListener: ((response: any) => void) | undefined;
    (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mockImplementation((listener) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    // Initial response with non-string url
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue({
      notification: {
        date: Date.now(),
        request: {
          identifier: 'n-invalid',
          content: {
            title: 'Test',
            body: 'Test',
            data: { url: 12345 },
          },
          trigger: null,
        },
      },
      actionIdentifier: 'default',
    });

    await renderHook(() => useNotificationObserver());

    await waitFor(() => {
      expect(capturedListener).toBeDefined();
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    // Listener with missing data
    capturedListener!({
      notification: {
        date: Date.now(),
        request: {
          identifier: 'n-no-data',
          content: { title: 'Test', body: 'Test' },
          trigger: null,
        },
      },
      actionIdentifier: 'default',
    });
    expect(router.push).not.toHaveBeenCalled();

    // Listener with external url (not starting with /)
    capturedListener!({
      notification: {
        date: Date.now(),
        request: {
          identifier: 'n-ext',
          content: {
            title: 'Test',
            body: 'Test',
            data: { url: 'https://external.example.com' },
          },
          trigger: null,
        },
      },
      actionIdentifier: 'default',
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  test('ignores null response in listener', async () => {
    let capturedListener: ((response: any) => void) | undefined;
    (
      Notifications.addNotificationResponseReceivedListener as jest.Mock
    ).mockImplementation((listener) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    await renderHook(() => useNotificationObserver());

    await waitFor(() => {
      expect(capturedListener).toBeDefined();
    });

    capturedListener!(null);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  test('web is no-op', async () => {
    Platform.OS = 'web';

    await renderHook(() => useNotificationObserver());

    await new Promise((r) => setTimeout(r, 50));
    expect(Notifications.getLastNotificationResponse).not.toHaveBeenCalled();
    expect(
      Notifications.addNotificationResponseReceivedListener,
    ).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
