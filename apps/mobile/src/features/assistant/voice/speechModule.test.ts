/* eslint-disable @typescript-eslint/no-require-imports -- a fresh module registry per test needs lazy requires */
const mockPackage = jest.fn();
jest.mock('expo-speech-recognition', () => mockPackage());

const module = { isRecognitionAvailable: jest.fn() };

/** The wrapper and its dependencies in a new module registry, so the package is required again. */
function load() {
  jest.resetModules();
  return {
    ...(require('./speechModule') as typeof import('./speechModule')),
    expo: require('expo') as typeof import('expo'),
    rn: require('react-native') as typeof import('react-native'),
  };
}

beforeEach(() => {
  mockPackage
    .mockReset()
    .mockReturnValue({ ExpoSpeechRecognitionModule: module });
});
afterEach(() => jest.restoreAllMocks());

test('returns the package module when the native module exists, and caches it', () => {
  const { getSpeechModule, expo } = load();
  expect(getSpeechModule()).toBe(module);
  expect(getSpeechModule()).toBe(module);
  expect(expo.requireOptionalNativeModule).toHaveBeenCalledTimes(1);
});

test('returns null without loading the package when the native module is missing (Expo Go)', () => {
  const { getSpeechModule, expo } = load();
  jest.mocked(expo.requireOptionalNativeModule).mockReturnValueOnce(null);
  expect(getSpeechModule()).toBeNull();
  expect(mockPackage).not.toHaveBeenCalled();
});

test('returns null when loading the package throws', () => {
  mockPackage.mockImplementation(() => {
    throw new Error('Cannot find native module ExpoSpeechRecognition');
  });
  expect(load().getSpeechModule()).toBeNull();
});

test('returns null when the package has no module', () => {
  mockPackage.mockReturnValue({});
  expect(load().getSpeechModule()).toBeNull();
});

test('forgets the cached lookup on reset', () => {
  const { getSpeechModule, resetSpeechModuleCache, expo } = load();
  jest.mocked(expo.requireOptionalNativeModule).mockReturnValueOnce(null);
  expect(getSpeechModule()).toBeNull();
  resetSpeechModuleCache();
  expect(getSpeechModule()).toBe(module);
});

test('the web loads the package without a native presence check', () => {
  const { getSpeechModule, expo, rn } = load();
  jest.replaceProperty(rn.Platform, 'OS', 'web');
  jest.mocked(expo.requireOptionalNativeModule).mockReturnValue(null);
  expect(getSpeechModule()).toBe(module);
  expect(expo.requireOptionalNativeModule).not.toHaveBeenCalled();
});
