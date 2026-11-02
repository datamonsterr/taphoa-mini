/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
const mockEnvironment = { executionEnvironment: 'storeClient' };
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockEnvironment,
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}));

it.each([
  ['storeClient', false],
  ['standalone', true],
])('selects the camera implementation for %s', (environment, native) => {
  jest.resetModules();
  mockEnvironment.executionEnvironment = environment;
  const nativeLoader = jest.fn(() => ({
    CameraPreview: 'native-preview',
    useCameraPermissions: 'native-permissions',
    supportsOneTripEnrollment: true,
  }));
  jest.doMock('./VisionCameraPreview', nativeLoader);
  const selected = require('./CameraPreview.native');
  expect(nativeLoader).toHaveBeenCalledTimes(native ? 1 : 0);
  expect(selected.supportsOneTripEnrollment).toBe(native);
});

it.each([
  ['storeClient', false],
  ['standalone', true],
])('guards the vision development screen for %s', (environment, native) => {
  jest.resetModules();
  mockEnvironment.executionEnvironment = environment;
  const nativeLoader = jest.fn(() => ({
    __esModule: true,
    default: 'native-dev',
  }));
  jest.doMock('./vision/NativeVisionDevScreen', nativeLoader);
  const selected = require('./vision/VisionDevScreen.native').default;
  expect(nativeLoader).toHaveBeenCalledTimes(native ? 1 : 0);
  expect(selected === 'native-dev').toBe(native);
});
