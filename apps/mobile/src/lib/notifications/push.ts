import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { registerDevice, unregisterDevice } from '@/lib/api/devices';
import { useSettingsStore, type Language } from '@/stores/settings';
import { clearLastToken, getLastToken, setLastToken } from './promptTiming';

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
    await Notifications.setNotificationChannelAsync('digest', {
      name: 'Tóm tắt hằng ngày',
      importance: AndroidImportance.HIGH,
    });
  }
}

export async function getPushPermission(): Promise<Notifications.NotificationPermissionsStatus | null> {
  if (Platform.OS === 'web') return null;
  return Notifications.getPermissionsAsync();
}

export async function requestPushPermission(): Promise<Notifications.NotificationPermissionsStatus | null> {
  if (Platform.OS === 'web') return null;
  return Notifications.requestPermissionsAsync();
}

/**
 * Returns the Expo push token, or null if on web, in Expo Go,
 * missing projectId in config, or permission not granted.
 */
export async function getExpoToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  if (Constants.appOwnership === 'expo') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return null;

  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return null;

  try {
    const response = await Notifications.getExpoPushTokenAsync({ projectId });
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
  if (Platform.OS === 'web') return null;

  await ensureChannel();

  const permission = await Notifications.getPermissionsAsync();
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
 * Reads persisted push token, calls unregisterDevice (ignoring errors),
 * and clears the persisted token.
 */
export async function unregisterPush(): Promise<void> {
  const token = await getLastToken();
  if (!token) return;

  try {
    await unregisterDevice(token);
  } catch {
    // Best-effort: ignore network/API errors when unregistering device
  }

  await clearLastToken();
}
