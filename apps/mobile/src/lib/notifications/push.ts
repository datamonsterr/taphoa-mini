import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { registerDevice, unregisterDevice } from '@/lib/api/devices';
import { isApiError } from '@/lib/api/errors';
import { useSettingsStore, type Language } from '@/stores/settings';
import { loadNotifications } from './module';
import { clearLastToken, getLastToken, setLastToken } from './promptTiming';

export type NotificationPermissionsStatus =
  NonNullable<ReturnType<typeof loadNotifications>> extends {
    getPermissionsAsync: () => Promise<infer R>;
  }
    ? R
    : never;

export type RegisterForPushOptions = {
  appVersion?: string;
  language?: Language;
};

/**
 * Android 13+ shows the permission prompt only after a notification channel exists.
 * Channel id `digest`, name `Tóm tắt hằng ngày`, importance HIGH.
 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    const notifications = loadNotifications();
    if (!notifications) return;
    await notifications.setNotificationChannelAsync('digest', {
      name: 'Tóm tắt hằng ngày',
      importance: notifications.AndroidImportance.HIGH,
    });
  }
}

export async function getPushPermission(): Promise<NotificationPermissionsStatus | null> {
  const notifications = loadNotifications();
  if (!notifications) return null;
  return notifications.getPermissionsAsync();
}

/**
 * Ensures channel exists first (required on Android 13+ before prompting),
 * then requests permission.
 */
export async function requestPushPermission(): Promise<NotificationPermissionsStatus | null> {
  const notifications = loadNotifications();
  if (!notifications) return null;
  await ensureChannel();
  return notifications.requestPermissionsAsync();
}

/**
 * Returns the Expo push token, or null if on web, in Expo Go,
 * missing projectId in config, or permission not granted.
 */
export async function getExpoToken(): Promise<string | null> {
  const notifications = loadNotifications();
  if (!notifications) return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return null;

  const permission = await notifications.getPermissionsAsync();
  if (!permission.granted) return null;

  try {
    const response = await notifications.getExpoPushTokenAsync({ projectId });
    return response.data;
  } catch {
    return null;
  }
}

/**
 * High-level registration flow:
 * 1. ensureChannel (Android)
 * 2. verify permission granted
 * 3. obtain Expo push token
 * 4. register device with backend
 * 5. persist registered token
 */
export async function registerForPush(
  options?: RegisterForPushOptions,
): Promise<string | null> {
  const notifications = loadNotifications();
  if (!notifications) return null;

  await ensureChannel();

  const permission = await notifications.getPermissionsAsync();
  if (!permission.granted) return null;

  const token = await getExpoToken();
  if (!token) return null;

  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const appVersion =
    options?.appVersion ?? Constants.expoConfig?.version ?? '0.0.0';
  const language =
    options?.language ?? useSettingsStore.getState().language ?? 'vi';

  await registerDevice({
    token,
    platform,
    app_version: appVersion,
    language,
  });

  await setLastToken(token);
  return token;
}

/**
 * Reads persisted push token, calls unregisterDevice.
 * Clears the persisted token only on success or on a 404/204 response.
 * Keeps the persisted token when DELETE fails (e.g. network/server error)
 * so the next launch or sign-in retries.
 */
export async function unregisterPush(): Promise<void> {
  const token = await getLastToken();
  if (!token) return;

  try {
    await unregisterDevice(token);
    await clearLastToken();
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.status === 204)) {
      await clearLastToken();
    }
  }
}
