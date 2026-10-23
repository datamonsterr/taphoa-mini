/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import 'react-native-gesture-handler/jestSetup';

// Reanimated's own jest mock needs native worklets; this one applies final values synchronously.
// expo-router/testing-library swaps it for an empty object; see renderApp in ./router.
// expo-router/testing-library would otherwise replace Reanimated (and expo-linking) with its own
// mocks; Reanimated's cannot load under this Reanimated/Worklets pair and resolves to `{}`.
jest.mock('expo-router/build/testing-library/mocks', () => ({}));

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

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The native module is absent under Jest. Each crop returns a distinct file uri and records its
// rect, so tests can assert what was cut out.
jest.mock('expo-image-manipulator', () => {
  const crops: Record<string, unknown>[] = [];
  return {
    __crops: crops,
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    ImageManipulator: {
      manipulate: (uri: string) => {
        const context = {
          crop: (rect: Record<string, unknown>) => {
            crops.push({ uri, ...rect });
            return context;
          },
          renderAsync: async () => ({
            saveAsync: async () => ({
              uri: `file:///crop-${crops.length}.jpg`,
              width: 1,
              height: 1,
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
