/* eslint-disable @typescript-eslint/no-require-imports -- Jest mock factories run before imports. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { useRef } from 'react';
import { Platform, TurboModuleRegistry } from 'react-native';
import { LivePreview } from './LivePreview';
import { useBarcodeScanner } from './useBarcodeScanner';
import type { PictureTaker } from './capture';

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: { hasHybridObject: jest.fn(() => true) },
}));

jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    CameraView: (props: object) => <View testID="expo-preview" {...props} />,
  };
});
jest.mock('./NativeLivePreview', () => {
  const { Pressable } = require('react-native');
  return {
    NativeLivePreview: ({
      onBarcodeScanned,
    }: {
      onBarcodeScanned: (value: object) => void;
    }) => (
      <Pressable
        testID="native-preview"
        onPress={() =>
          onBarcodeScanned({ data: '4006381333931', type: 'EAN_13' })
        }
      />
    ),
  };
});

const lookup = jest.fn().mockResolvedValue({ id: 'known' });
const onResult = jest.fn();
function Harness() {
  const cameraRef = useRef<PictureTaker>(null);
  const scanningRef = useRef(true);
  const scanner = useBarcodeScanner({
    enabled: true,
    lookup,
    onResult,
    onError: jest.fn(),
  });
  return (
    <LivePreview
      cameraRef={cameraRef}
      scanningRef={scanningRef}
      onBarcodeScanned={scanner.scan}
      onReadyChange={jest.fn()}
      dropHandler={false}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_NATIVE_CAMERA;
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_NATIVE_CAMERA;
  jest.restoreAllMocks();
});

test('defaults to Expo camera even when Nitro is available', async () => {
  jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue({} as never);
  await render(<Harness />);
  expect(screen.getByTestId('expo-preview')).toBeTruthy();
  expect(screen.queryByTestId('native-preview')).toBeNull();
});

test('flagged native result reaches the existing barcode lookup', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue({} as never);
  process.env.EXPO_PUBLIC_NATIVE_CAMERA = '1';
  await render(<Harness />);
  await fireEvent.press(screen.getByTestId('native-preview'));
  await waitFor(() => expect(lookup).toHaveBeenCalledWith('4006381333931'));
  expect(onResult).toHaveBeenCalledWith('4006381333931', { id: 'known' });
});

test('falls back when Nitro is unavailable', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue(null);
  process.env.EXPO_PUBLIC_NATIVE_CAMERA = '1';
  await render(<Harness />);
  expect(screen.getByTestId('expo-preview')).toBeTruthy();
});
