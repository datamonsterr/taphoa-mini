/* eslint-disable @typescript-eslint/no-require-imports -- Native modules must be loaded conditionally. */
const mockGet = jest.fn();
const mockHasHybridObject = jest.fn();
jest.mock('react-native-nitro-modules', () => ({
  NitroModules: { hasHybridObject: mockHasHybridObject },
}));

beforeEach(() => {
  mockGet.mockReset();
  mockHasHybridObject.mockReset();
});

function mockTurboModuleRegistry() {
  jest.doMock('react-native/Libraries/TurboModule/TurboModuleRegistry', () => {
    const actual = jest.requireActual(
      'react-native/Libraries/TurboModule/TurboModuleRegistry',
    );
    return {
      ...actual,
      get: (name: string) =>
        name === 'NitroModules' ? mockGet(name) : actual.get(name),
    };
  });
}

it.each([
  ['NitroModules missing', null, false, false],
  ['NitroModules present and ObjectDetector registered', {}, true, true],
  ['ObjectDetector not registered', {}, false, false],
])(
  'selects camera implementation when %s',
  (_label, turboModule, hybrid, native) => {
    jest.resetModules();
    mockTurboModuleRegistry();
    mockGet.mockReturnValue(turboModule);
    mockHasHybridObject.mockReturnValue(hybrid);
    const nativeLoader = jest.fn(() => ({
      CameraPreview: 'native-preview',
      useCameraPermissions: 'native-permissions',
      supportsOneTripEnrollment: true,
    }));
    jest.doMock('./VisionCameraPreview', nativeLoader);
    const selected = require('./CameraPreview.native');
    expect(mockGet).toHaveBeenCalledWith('NitroModules');
    expect(nativeLoader).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(selected.supportsOneTripEnrollment).toBe(native);
  },
);

it.each([
  ['NitroModules missing', null, false, false],
  ['NitroModules present and ObjectDetector registered', {}, true, true],
])(
  'guards vision development screen when %s',
  (_label, turboModule, hybrid, native) => {
    jest.resetModules();
    mockTurboModuleRegistry();
    mockGet.mockReturnValue(turboModule);
    mockHasHybridObject.mockReturnValue(hybrid);
    const nativeLoader = jest.fn(() => ({
      __esModule: true,
      default: 'native-dev',
    }));
    jest.doMock('./vision/NativeVisionDevScreen', nativeLoader);
    const selected = require('./vision/VisionDevScreen.native').default;
    expect(mockGet).toHaveBeenCalledWith('NitroModules');
    expect(nativeLoader).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(selected === 'native-dev').toBe(native);
  },
);

it.each(['get', 'hybrid'])(
  'keeps native modules unloaded when the %s lookup throws',
  (lookup) => {
    jest.resetModules();
    mockTurboModuleRegistry();
    mockGet.mockReturnValue({});
    if (lookup === 'get')
      mockGet.mockImplementation(() => {
        throw new Error('unavailable');
      });
    else
      mockHasHybridObject.mockImplementation(() => {
        throw new Error('unavailable');
      });
    const nativeLoader = jest.fn(() => ({ CameraPreview: 'native-preview' }));
    jest.doMock('./VisionCameraPreview', nativeLoader);
    const selected = require('./CameraPreview.native');
    expect(nativeLoader).not.toHaveBeenCalled();
    expect(selected.supportsOneTripEnrollment).toBe(false);
  },
);
