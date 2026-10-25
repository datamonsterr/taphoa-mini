/* eslint-disable @typescript-eslint/no-require-imports -- the package must load lazily: importing it throws where its native module is missing */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import type { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

export type SpeechModule = typeof ExpoSpeechRecognitionModule;

let cached: SpeechModule | null | undefined;

/**
 * The speech recognition module, or null where it does not exist (Expo Go does not ship the
 * native module, and `expo-speech-recognition` throws when it is imported without it). The web
 * registers its own module when the package loads, so only native checks for presence first.
 */
export function getSpeechModule(): SpeechModule | null {
  if (cached !== undefined) return cached;
  try {
    cached =
      Platform.OS !== 'web' &&
      !requireOptionalNativeModule('ExpoSpeechRecognition')
        ? null
        : ((
            require('expo-speech-recognition') as typeof import('expo-speech-recognition')
          ).ExpoSpeechRecognitionModule ?? null);
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam: forget the cached lookup. */
export function resetSpeechModuleCache() {
  cached = undefined;
}
