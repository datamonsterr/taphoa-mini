import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';

let hasWarned = false;

export function resetNotificationModuleWarning(): void {
  hasWarned = false;
}

/**
 * Lazily loads expo-notifications native module.
 * Returns null on web, in Expo Go, or if the native module fails to load.
 * SDK 58's entry point eagerly imports ExpoTopicSubscriptionModule on Android,
 * which is absent in Expo Go: check the environment before evaluating the package.
 */
export function loadNotifications():
  typeof import('expo-notifications') | null {
  if (Platform.OS === 'web') return null;
  if (
    Constants.appOwnership === 'expo' ||
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  ) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as typeof import('expo-notifications');
  } catch (error) {
    if (!hasWarned) {
      hasWarned = true;
      console.warn('Failed to load expo-notifications:', error);
    }
    return null;
  }
}

/**
 * Configures the foreground notification display handler.
 * No-op when loadNotifications returns null (web, Expo Go, missing native module).
 */
export function configureNotificationHandler(): void {
  const notifications = loadNotifications();
  if (!notifications) return;

  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}
