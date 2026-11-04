import { render, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import RootLayout from '@/app/_layout';
import {
  configureNotificationHandler,
  getPushPermission,
  loadNotifications,
  useNotificationObserver,
} from './index';

const mockNotificationImport = jest.fn();

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

jest.mock('expo-constants', () => {
  const actual = jest.requireActual('expo-constants');
  return {
    ...actual,
    __esModule: true,
    default: {
      ...actual.default,
      appOwnership: null,
      executionEnvironment: actual.ExecutionEnvironment.StoreClient,
    },
  };
});

// SDK 58's notifications entry point eagerly requires this Android push module,
// which Expo Go does not ship. A successful mock would hide the startup crash.
jest.mock('expo-notifications', () => {
  mockNotificationImport();
  throw new Error("Cannot find native module 'ExpoTopicSubscriptionModule'");
});

test('Expo Go imports and renders the root without evaluating notifications', async () => {
  const platform = Platform.OS;
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  Platform.OS = 'android';
  delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  try {
    const view = await render(<RootLayout />);
    expect(view.getByTestId('auth-configuration-error')).toBeTruthy();
    configureNotificationHandler();
    expect(loadNotifications()).toBeNull();
    expect(await getPushPermission()).toBeNull();
    await renderHook(() => useNotificationObserver(true));
    expect(mockNotificationImport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      'Failed to load expo-notifications:',
      expect.anything(),
    );
  } finally {
    Platform.OS = platform;
    if (key === undefined) {
      delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = key;
    }
    warn.mockRestore();
  }
});
