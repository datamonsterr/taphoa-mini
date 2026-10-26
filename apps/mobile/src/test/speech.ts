/* eslint-disable @typescript-eslint/no-require-imports -- must be the registry instance the code under test imports (jest.requireMock returns a separate copy) */

/** Controls for the `expo-speech-recognition` Jest double; see `__mocks__/expo-speech-recognition.ts`. */
export const { speechMock } =
  require('expo-speech-recognition') as typeof import('../../__mocks__/expo-speech-recognition');
