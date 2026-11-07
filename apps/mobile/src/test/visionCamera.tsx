/* eslint-disable @typescript-eslint/no-require-imports -- Jest native doubles load React lazily. */
import type { ObjectBox } from '@/features/camera/vision/tracker';
import type { UseFrameOutputProps } from 'react-native-vision-camera';
import type { BarcodeScannerOutputOptions } from 'react-native-vision-camera-barcode-scanner';

export const visionMock = {
  runtime: 'rn' as 'rn' | 'frame' | 'ui',
  uiUpdates: jest.fn(),
  mounts: 0,
  renders: 0,
  frameOptions: {} as UseFrameOutputProps,
  barcodeOptions: {} as BarcodeScannerOutputOptions,
  frameOutput: { dispose: jest.fn() },
  photoOutput: {
    dispose: jest.fn(),
    capturePhotoToFile: jest.fn(async () => ({
      filePath: '/vision.jpg',
      width: 100,
      height: 200,
    })),
  },
  barcodeOutput: { dispose: jest.fn() },
  frame: { dispose: jest.fn() },
  asyncRunner: {
    isBusy: jest.fn(() => false),
    runAsync: jest.fn((task: () => void) => {
      task();
      return true;
    }),
  },
  thumb: {
    width: 160,
    height: 160,
    getPixelBuffer: jest.fn(() => new Uint8Array(160 * 160 * 4).buffer),
    dispose: jest.fn(),
  },
  image: {
    width: 1280,
    height: 960,
    resize: jest.fn(),
    saveToTemporaryFileAsync: jest.fn(async () => '/keyframe.jpg'),
    dispose: jest.fn(),
  },
  resizer: { resize: jest.fn(), dispose: jest.fn() },
  detector: {
    dispose: jest.fn(),
    getFrameMetadata: jest.fn(() => ({
      width: 100,
      height: 200,
      rotation: 0,
      isMirrored: false,
    })),
    detectObjects: jest.fn<ObjectBox[], [unknown]>(() => []),
  },
  emit(objects: ObjectBox[]) {
    this.detector.detectObjects.mockReturnValueOnce(objects);
    this.runtime = 'frame';
    try {
      this.frameOptions.onFrame?.(
        this.frame as unknown as Parameters<
          NonNullable<UseFrameOutputProps['onFrame']>
        >[0],
      );
    } finally {
      this.runtime = 'rn';
    }
  },
  reset() {
    this.runtime = 'rn';
    this.uiUpdates.mockClear();
    this.mounts = 0;
    this.renders = 0;
    this.frame.dispose.mockClear();
    this.frameOutput.dispose.mockClear();
    this.photoOutput.dispose.mockClear();
    this.barcodeOutput.dispose.mockClear();
    this.detector.detectObjects.mockReset().mockReturnValue([]);
    this.detector.dispose.mockClear();
    this.asyncRunner.runAsync.mockClear();
    this.asyncRunner.isBusy.mockReturnValue(false);
    this.resizer.resize.mockReturnValue(this.thumb);
    this.image.resize.mockReturnValue(this.image);
  },
};

export function createVisionCameraMock() {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Camera: (props: { onPreviewStarted?: () => void }) => {
      const { onPreviewStarted } = props;
      visionMock.renders++;
      React.useEffect(() => {
        visionMock.mounts++;
        onPreviewStarted?.();
      }, [onPreviewStarted]);
      return <View testID="vision-camera" {...props} />;
    },
    useCameraPermission: () => ({
      hasPermission: true,
      canRequestPermission: true,
      requestPermission: jest.fn(async () => true),
    }),
    useFrameOutput: (options: UseFrameOutputProps) => {
      visionMock.frameOptions = options;
      return visionMock.frameOutput;
    },
    usePhotoOutput: () => visionMock.photoOutput,
    useAsyncRunner: () => visionMock.asyncRunner,
    HybridFrameConverter: { convertFrameToImage: () => visionMock.image },
  };
}
export function createBarcodeMock() {
  return {
    useBarcodeScannerOutput: (options: BarcodeScannerOutputOptions) => {
      visionMock.barcodeOptions = options;
      return visionMock.barcodeOutput;
    },
  };
}
export function createWorkletsMock() {
  return {
    createSynchronizable: <T,>(initial: T) => {
      let value = initial;
      return {
        getBlocking: () => value,
        setBlocking: (next: T | ((previous: T) => T)) => {
          value =
            typeof next === 'function'
              ? (next as (previous: T) => T)(value)
              : next;
        },
      };
    },
    // Worklets 0.13 legacy mode supports scheduleOnUI only from the RN runtime.
    scheduleOnUI: (fn: () => void) => {
      if (visionMock.runtime !== 'rn')
        throw new Error('Tried to synchronously call a Remote Function');
      fn();
    },
    UIRuntimeId: 2,
    scheduleOnRuntimeWithId: (id: number, fn: () => void) => {
      if (id !== 2) throw new Error('Unexpected runtime');
      const previous = visionMock.runtime;
      visionMock.runtime = 'ui';
      visionMock.uiUpdates();
      try {
        fn();
      } finally {
        visionMock.runtime = previous;
      }
    },
    scheduleOnRN: <T extends unknown[]>(fn: (...args: T) => void, ...args: T) =>
      fn(...args),
  };
}
