import { Platform } from 'react-native';
import { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import {
  configureNotificationHandler,
  loadNotifications,
  resetNotificationModuleWarning,
} from './module';

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
    get appOwnership() {
      return mockAppOwnership;
    },
    get executionEnvironment() {
      return mockExecutionEnvironment;
    },
  },
}));

describe('notifications module loader', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    resetNotificationModuleWarning();
    Platform.OS = 'android';
    mockAppOwnership = 'standalone';
    mockExecutionEnvironment = 'standalone';
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  test('returns null on web', () => {
    Platform.OS = 'web';
    expect(loadNotifications()).toBeNull();
  });

  test('returns null in Expo Go via Constants.appOwnership', () => {
    mockAppOwnership = 'expo';
    expect(loadNotifications()).toBeNull();
  });

  test('returns null in Expo Go via Constants.executionEnvironment storeClient', () => {
    mockExecutionEnvironment = ExecutionEnvironment.StoreClient;
    expect(loadNotifications()).toBeNull();
  });

  test('returns expo-notifications module on native non-expo-go platform', () => {
    const mod = loadNotifications();
    expect(mod).not.toBeNull();
    expect(mod?.setNotificationHandler).toBe(
      Notifications.setNotificationHandler,
    );
  });

  describe('configureNotificationHandler', () => {
    test('is a no-op when loadNotifications returns null (e.g. web or Expo Go)', () => {
      Platform.OS = 'web';
      configureNotificationHandler();
      expect(Notifications.setNotificationHandler).not.toHaveBeenCalled();

      Platform.OS = 'android';
      mockAppOwnership = 'expo';
      configureNotificationHandler();
      expect(Notifications.setNotificationHandler).not.toHaveBeenCalled();
    });

    test('sets notification handler when notifications module is loaded', async () => {
      configureNotificationHandler();
      expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
      const call = (Notifications.setNotificationHandler as jest.Mock).mock
        .calls[0][0];
      const result = await call.handleNotification();
      expect(result).toEqual({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
    });
  });

  test('logs once with console.warn and returns null when require throws', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    jest.isolateModules(() => {
      jest.resetModules();
      jest.doMock('expo-notifications', () => {
        throw new Error(
          "Cannot find native module 'ExpoTopicSubscriptionModule'",
        );
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolatedModule = require('./module');
      isolatedModule.resetNotificationModuleWarning();

      const first = isolatedModule.loadNotifications();
      expect(first).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load expo-notifications:'),
        expect.any(Error),
      );

      // Second call does not warn again (log once)
      const second = isolatedModule.loadNotifications();
      expect(second).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    warnSpy.mockRestore();
  });
});
