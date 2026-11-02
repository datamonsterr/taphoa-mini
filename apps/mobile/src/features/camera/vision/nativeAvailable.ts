/* eslint-disable @typescript-eslint/no-require-imports -- Nitro's enforcing import must stay lazy. */
import { TurboModuleRegistry } from 'react-native';

let cachedAvailability: boolean | undefined;

/** True when this native binary contains Nitro and our detector hybrid object. */
export function isVisionNativeAvailable(): boolean {
  if (cachedAvailability !== undefined) return cachedAvailability;

  try {
    if (TurboModuleRegistry.get('NitroModules') == null) {
      cachedAvailability = false;
      return cachedAvailability;
    }

    // Loading NitroModules installs its JS proxy. Keep this require lazy because
    // the package uses getEnforcing and throws in Expo Go.
    const { NitroModules } =
      require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    cachedAvailability = NitroModules.hasHybridObject('ObjectDetector');
  } catch {
    cachedAvailability = false;
  }

  return cachedAvailability;
}
