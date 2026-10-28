/* eslint-disable @typescript-eslint/no-require-imports -- must be the registry instance the code under test imports (jest.requireMock returns a separate copy) */

/** Controls for the `expo-audio` Jest double; see `__mocks__/expo-audio.ts`. */
export const { audioMock } =
  require('expo-audio') as typeof import('../../__mocks__/expo-audio');
