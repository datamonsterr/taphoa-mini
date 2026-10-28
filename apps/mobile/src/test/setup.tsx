/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import 'react-native-gesture-handler/jestSetup';

// Reanimated's own jest mock needs native worklets; this one applies final values synchronously.
// expo-router/testing-library swaps it for an empty object; see renderApp in ./router.
// expo-router/testing-library would otherwise replace Reanimated (and expo-linking) with its own
// mocks; Reanimated's cannot load under this Reanimated/Worklets pair and resolves to `{}`.
jest.mock('expo-router/build/testing-library/mocks', () => ({}));

// The speech module is "installed" in Jest (its double lives in __mocks__); a test that needs it
// missing makes `requireOptionalNativeModule` return null again (see voice/speechModule.test.ts).
jest.mock('expo', () => {
  const actual = jest.requireActual('expo');
  return {
    ...actual,
    requireOptionalNativeModule: jest.fn((name: string) =>
      name === 'ExpoSpeechRecognition'
        ? {}
        : actual.requireOptionalNativeModule(name),
    ),
  };
});

jest.mock('react-native-reanimated', () =>
  require('./reanimated').createReanimatedMock(),
);

// FlashList measures native layout and virtualizes by window size; a FlatList keeps the same
// props (data, renderItem, numColumns, onEndReached) with deterministic rendering.
jest.mock('@shopify/flash-list', () => ({
  FlashList: jest.requireActual('react-native').FlatList,
}));

jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ value }: { value: string }) => (
      <View testID="qr-code" accessibilityLabel={value} />
    ),
  };
});

// lucide-react-native ships ESM that jest does not transform. Every icon
// renders as an empty View named after the icon (testID "icon-<Name>").
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const cache: Record<string, unknown> = {};
  return new Proxy(
    { __esModule: true },
    {
      get(target, name) {
        if (typeof name !== 'string' || name in target) {
          return Reflect.get(target, name);
        }
        cache[name] ??= Object.assign(
          // `aria-hidden` (set by Icon for the web DOM) would hide the glyph from test queries;
          // render it as a plain non-accessible View instead.
          ({ 'aria-hidden': _hidden, ...props }: Record<string, unknown>) =>
            React.createElement(View, {
              testID: `icon-${name}`,
              accessible: false,
              ...props,
            }),
          { displayName: name },
        );
        return cache[name];
      },
    },
  );
});

jest.mock('expo-contacts', () => ({
  Contact: { presentPicker: jest.fn().mockResolvedValue(null) },
}));

jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const CameraView = React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        takePictureAsync: jest.fn().mockResolvedValue({
          uri: 'file:///mock.jpg',
          width: 1080,
          height: 1440,
        }),
      }));
      const onReady = props.onCameraReady as (() => void) | undefined;
      React.useEffect(() => onReady?.(), [onReady]);
      return React.createElement(View, { testID: 'camera-view', ...props });
    },
  );
  CameraView.displayName = 'CameraView';
  const granted = { granted: true, status: 'granted', canAskAgain: true };
  return {
    CameraView,
    useCameraPermissions: () => [granted, jest.fn().mockResolvedValue(granted)],
  };
});

// The Keychain / Keystore is absent under Jest: an in-memory map stands in for it.
jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    __values: values,
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The native module is absent under Jest. Each crop returns a distinct file uri and records its
// rect, so tests can assert what was cut out. Resizes record options and reflect target dimensions.
jest.mock('expo-image-manipulator', () => {
  const crops: Record<string, unknown>[] = [];
  const resizes: Record<string, unknown>[] = [];
  return {
    __crops: crops,
    __resizes: resizes,
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    ImageManipulator: {
      manipulate: (uri: string) => {
        let isResize = false;
        let targetDimensions: { width?: number; height?: number } | undefined;
        const context = {
          crop: (rect: Record<string, unknown>) => {
            crops.push({ uri, ...rect });
            return context;
          },
          resize: (options: { width?: number; height?: number }) => {
            isResize = true;
            resizes.push({ uri, ...options });
            targetDimensions = options;
            return context;
          },
          renderAsync: async () => ({
            saveAsync: async () => ({
              uri: isResize
                ? `file:///downsize-${resizes.length}.jpg`
                : `file:///crop-${crops.length}.jpg`,
              width: targetDimensions?.width ?? 1,
              height: targetDimensions?.height ?? 1,
            }),
          }),
        };
        return context;
      },
    },
  };
});

// The native module is absent under Jest: a download "lands" in the cache under the url's name.
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: function Directory(this: { uri: string }, uri: string) {
    this.uri = uri;
  },
  File: {
    downloadFileAsync: async (url: string) => ({
      uri: `file:///cache/${url.split('/').pop()}`,
    }),
  },
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
}));

jest.mock('expo-font', () => ({
  ...jest.requireActual('expo-font'),
  useFonts: () => [true, null],
  loadAsync: jest.fn().mockResolvedValue(undefined),
  isLoaded: () => true,
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(true),
  hideAsync: jest.fn().mockResolvedValue(true),
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: {
    UNKNOWN: 0,
    UNSPECIFIED: 1,
    NONE: 2,
    MIN: 3,
    LOW: 4,
    DEFAULT: 5,
    HIGH: 6,
    MAX: 7,
  },
  getPermissionsAsync: jest.fn().mockResolvedValue({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
  }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
    expires: 'never',
  }),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({
    data: 'ExponentPushToken[mock-token-xyz]',
  }),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
}));

jest.mock('posthog-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const fake = require('./posthog');
  return {
    PostHogProvider: (props: { children: React.ReactNode }) => {
      fake.providerProps(props);
      return props.children;
    },
    usePostHog: () => fake.posthog,
    useFeatureFlag: (key: string) => fake.featureFlags.get(key),
    PostHogMaskView: (props: Record<string, unknown>) =>
      React.createElement(View, { ...props, collapsable: false }),
  };
});
jest.mock('expo-application', () => ({ nativeBuildVersion: '123' }));
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'vi-VN', languageCode: 'vi' }],
}));
jest.mock('@clerk/expo', () => require('./clerk'));
jest.mock('@clerk/expo/token-cache', () => ({ tokenCache: {} }));
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  warmUpAsync: jest.fn(),
  coolDownAsync: jest.fn(),
}));
process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_jest';

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(
    ({ scheme, path }: { scheme: string; path: string }) =>
      `${scheme}://${path}`,
  ),
}));
