import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { loadNotifications } from './module';

/**
 * Handles notification deep links:
 * When enabled is true and notification.request.content.data.url is a string starting with '/',
 * routes via router.push(url) then calls clearLastNotificationResponse().
 * Other payloads are ignored. No-op on web, in Expo Go, or when enabled is false.
 */
export function useNotificationObserver(enabled: boolean): void {
  useEffect(() => {
    if (Platform.OS === 'web' || !enabled) return;

    const notifications = loadNotifications();
    if (!notifications) return;

    let isMounted = true;

    function handleResponse(
      response: import('expo-notifications').NotificationResponse | null,
    ) {
      if (!response) return;
      const url = response.notification?.request?.content?.data?.url;
      if (typeof url === 'string' && url.startsWith('/')) {
        router.push(url as never);
        notifications?.clearLastNotificationResponse();
      }
    }

    const initial = notifications.getLastNotificationResponse();
    if (initial) {
      handleResponse(initial);
    }

    const subscription = notifications.addNotificationResponseReceivedListener(
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
