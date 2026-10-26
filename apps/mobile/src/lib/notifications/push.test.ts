import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '@/stores/settings';
import * as devicesApi from '@/lib/api/devices';
import { ApiError } from '@/lib/api/errors';
import {
  ensureChannel,
  getExpoToken,
  getPushPermission,
  registerForPush,
  requestPushPermission,
  unregisterPush,
} from './push';
import { getLastToken, setLastToken } from './promptTiming';

let mockExpoConfig: Record<string, unknown> | null = {
  name: 'Tạp Hóa Mini',
  slug: 'taphoamini',
  version: '1.2.3',
  extra: { eas: { projectId: 'test-project-id' } },
};
let mockAppOwnership: string | null = 'standalone';
let mockExecutionEnvironment: string | null = 'standalone';

jest.mock('expo-constants', () => ({
  __esModule: true,
  ExecutionEnvironment: {
    Bare: 'bare',
    Standalone: 'standalone',
    StoreClient: 'storeClient',
  },
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
    get appOwnership() {
      return mockAppOwnership;
    },
    get executionEnvironment() {
      return mockExecutionEnvironment;
    },
  },
}));

jest.mock('@/lib/api/devices');

describe('push notifications', () => {
  const originalPlatform = Platform.OS;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    Platform.OS = 'android';
    mockAppOwnership = 'standalone';
    mockExecutionEnvironment = 'standalone';
    mockExpoConfig = {
      name: 'Tạp Hóa Mini',
      slug: 'taphoamini',
      version: '1.2.3',
      extra: { eas: { projectId: 'test-project-id' } },
    };
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
      data: 'ExponentPushToken[mock-token-123]',
    });
    (devicesApi.registerDevice as jest.Mock).mockResolvedValue({
      token: 'ExponentPushToken[mock-token-123]',
      platform: 'android',
      app_version: '1.2.3',
      language: 'vi',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    (devicesApi.unregisterDevice as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  describe('ensureChannel', () => {
    test('creates digest channel with HIGH importance on Android', async () => {
      Platform.OS = 'android';
      await ensureChannel();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        'digest',
        {
          name: 'Tóm tắt hằng ngày',
          importance: AndroidImportance.HIGH,
        },
      );
    });

    test('is no-op on iOS and web', async () => {
      Platform.OS = 'ios';
      await ensureChannel();
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();

      Platform.OS = 'web';
      await ensureChannel();
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    });

    test('is no-op in Expo Go', async () => {
      Platform.OS = 'android';
      mockAppOwnership = 'expo';
      await ensureChannel();
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    });
  });

  describe('permissions', () => {
    test('getPushPermission and requestPushPermission return null on web and in Expo Go', async () => {
      Platform.OS = 'web';
      expect(await getPushPermission()).toBeNull();
      expect(await requestPushPermission()).toBeNull();
      expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();

      Platform.OS = 'android';
      mockAppOwnership = 'expo';
      expect(await getPushPermission()).toBeNull();
      expect(await requestPushPermission()).toBeNull();
      expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    test('getPushPermission and requestPushPermission call expo-notifications on native', async () => {
      Platform.OS = 'android';
      const perm = await getPushPermission();
      expect(perm?.granted).toBe(true);
      expect(Notifications.getPermissionsAsync).toHaveBeenCalled();

      const callOrder: string[] = [];
      (
        Notifications.setNotificationChannelAsync as jest.Mock
      ).mockImplementationOnce(async () => {
        callOrder.push('channel');
        return null;
      });
      (
        Notifications.requestPermissionsAsync as jest.Mock
      ).mockImplementationOnce(async () => {
        callOrder.push('permissions');
        return { status: 'granted', granted: true, canAskAgain: true };
      });

      const reqPerm = await requestPushPermission();
      expect(reqPerm?.granted).toBe(true);
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        'digest',
        expect.objectContaining({ name: 'Tóm tắt hằng ngày' }),
      );
      expect(callOrder).toEqual(['channel', 'permissions']);
    });
  });

  describe('getExpoToken', () => {
    test('returns null on web', async () => {
      Platform.OS = 'web';
      expect(await getExpoToken()).toBeNull();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    test('returns null in Expo Go (appOwnership === "expo")', async () => {
      Platform.OS = 'android';
      mockAppOwnership = 'expo';
      expect(await getExpoToken()).toBeNull();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    test('returns null when projectId is missing', async () => {
      Platform.OS = 'android';
      mockExpoConfig = {
        name: 'Tạp Hóa Mini',
        slug: 'taphoamini',
        version: '1.0.0',
      };
      expect(await getExpoToken()).toBeNull();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    test('returns null when permission is not granted', async () => {
      Platform.OS = 'android';
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
      });
      expect(await getExpoToken()).toBeNull();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    test('returns token when permission granted on native', async () => {
      Platform.OS = 'android';
      const token = await getExpoToken();
      expect(token).toBe('ExponentPushToken[mock-token-123]');
      expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
        projectId: 'test-project-id',
      });
    });

    test('returns null if getExpoPushTokenAsync throws', async () => {
      Platform.OS = 'android';
      (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValueOnce(
        new Error('Expo server down'),
      );
      expect(await getExpoToken()).toBeNull();
    });
  });

  describe('registerForPush', () => {
    test('creates channel before requesting token and registers device with API', async () => {
      Platform.OS = 'android';
      const callOrder: string[] = [];
      (
        Notifications.setNotificationChannelAsync as jest.Mock
      ).mockImplementation(async () => {
        callOrder.push('setNotificationChannelAsync');
        return null;
      });
      (Notifications.getExpoPushTokenAsync as jest.Mock).mockImplementation(
        async () => {
          callOrder.push('getExpoPushTokenAsync');
          return { data: 'ExponentPushToken[mock-token-123]' };
        },
      );

      useSettingsStore.setState({ language: 'vi' });
      const token = await registerForPush();

      expect(token).toBe('ExponentPushToken[mock-token-123]');
      expect(callOrder).toEqual([
        'setNotificationChannelAsync',
        'getExpoPushTokenAsync',
      ]);
      expect(devicesApi.registerDevice).toHaveBeenCalledWith({
        token: 'ExponentPushToken[mock-token-123]',
        platform: 'android',
        app_version: '1.2.3',
        language: 'vi',
      });
      expect(await getLastToken()).toBe('ExponentPushToken[mock-token-123]');
    });

    test('no registration when permission is denied', async () => {
      Platform.OS = 'android';
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
      });

      const token = await registerForPush();
      expect(token).toBeNull();
      expect(devicesApi.registerDevice).not.toHaveBeenCalled();
      expect(await getLastToken()).toBeNull();
    });

    test('web and Expo Go return null and do not register', async () => {
      Platform.OS = 'web';
      expect(await registerForPush()).toBeNull();
      expect(devicesApi.registerDevice).not.toHaveBeenCalled();

      Platform.OS = 'android';
      mockAppOwnership = 'expo';
      expect(await registerForPush()).toBeNull();
      expect(devicesApi.registerDevice).not.toHaveBeenCalled();
    });

    test('passes custom appVersion and language options when provided', async () => {
      Platform.OS = 'ios';
      const token = await registerForPush({
        appVersion: '2.0.0',
        language: 'en',
      });
      expect(token).toBe('ExponentPushToken[mock-token-123]');
      expect(devicesApi.registerDevice).toHaveBeenCalledWith({
        token: 'ExponentPushToken[mock-token-123]',
        platform: 'ios',
        app_version: '2.0.0',
        language: 'en',
      });
    });
  });

  describe('unregisterPush', () => {
    test('reads persisted token, calls unregisterDevice and clears token on success', async () => {
      await setLastToken('ExponentPushToken[mock-token-123]');
      expect(await getLastToken()).toBe('ExponentPushToken[mock-token-123]');

      await unregisterPush();

      expect(devicesApi.unregisterDevice).toHaveBeenCalledWith(
        'ExponentPushToken[mock-token-123]',
      );
      expect(await getLastToken()).toBeNull();
    });

    test('clears token on 404 or 204 ApiError', async () => {
      // 404 ApiError
      await setLastToken('ExponentPushToken[mock-token-123]');
      (devicesApi.unregisterDevice as jest.Mock).mockRejectedValueOnce(
        new ApiError(404, { error: 'Not found' }),
      );

      await unregisterPush();
      expect(await getLastToken()).toBeNull();

      // 204 ApiError
      await setLastToken('ExponentPushToken[mock-token-123]');
      (devicesApi.unregisterDevice as jest.Mock).mockRejectedValueOnce(
        new ApiError(204, { error: 'No content' }),
      );

      await unregisterPush();
      expect(await getLastToken()).toBeNull();
    });

    test('keeps token when DELETE fails on network error or 500 so next run retries', async () => {
      await setLastToken('ExponentPushToken[mock-token-123]');
      (devicesApi.unregisterDevice as jest.Mock).mockRejectedValueOnce(
        new Error('Network error'),
      );

      await unregisterPush();

      expect(devicesApi.unregisterDevice).toHaveBeenCalledWith(
        'ExponentPushToken[mock-token-123]',
      );
      expect(await getLastToken()).toBe('ExponentPushToken[mock-token-123]');

      // 500 server error
      (devicesApi.unregisterDevice as jest.Mock).mockRejectedValueOnce(
        new ApiError(500, { error: 'Server error' }),
      );

      await unregisterPush();
      expect(await getLastToken()).toBe('ExponentPushToken[mock-token-123]');
    });

    test('is no-op when no persisted token exists', async () => {
      await unregisterPush();
      expect(devicesApi.unregisterDevice).not.toHaveBeenCalled();
    });
  });
});
