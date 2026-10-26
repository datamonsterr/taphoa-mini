import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Handles notification deep links:
 * When enabled is true and notification.request.content.data.url is a string starting with '/',
 * routes via router.push(url) then calls clearLastNotificationResponse().
 * Other payloads are ignored. No-op on web or when enabled is false.
 */
export function useNotificationObserver(enabled: boolean): void {
  useEffect(() => {
    if (Platform.OS === 'web' || !enabled) return;

    let isMounted = true;

    function handleResponse(
      response: Notifications.NotificationResponse | null,
    ) {
      if (!response) return;
      const url = response.notification?.request?.content?.data?.url;
      if (typeof url === 'string' && url.startsWith('/')) {
        router.push(url as never);
        Notifications.clearLastNotificationResponse();
      }
    }

    const initial = Notifications.getLastNotificationResponse();
    if (initial) {
      handleResponse(initial);
    }

    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (isMounted) {
          handleResponse(response);
        }
      },
    );

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [enabled]);
}
