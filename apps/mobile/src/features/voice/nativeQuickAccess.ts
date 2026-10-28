import { Platform } from 'react-native';

import { requestPushPermission } from '@/lib/notifications/push';

import {
  nativeVoiceBubble,
  type NativeVoiceBubble,
} from '../../../modules/voice-bubble';
import type { VoiceBubble, VoiceTile } from './quickAccess';

type Deps = {
  module?: () => NativeVoiceBubble | null;
  os?: () => string;
  sdk?: () => number;
  askNotifications?: () => Promise<unknown>;
};

/** Android 13 (API 33): notification permission is a runtime prompt and tiles can be requested. */
const API_TIRAMISU = 33;

/**
 * The bubble and tile backed by the Kotlin module. `module()` is read on every call, so a build
 * without the module (or a test) is handled without restarting.
 */
export function nativeQuickAccess(deps: Deps = {}): {
  bubble: VoiceBubble;
  tile: VoiceTile;
} {
  const getModule = deps.module ?? nativeVoiceBubble;
  const os = deps.os ?? (() => Platform.OS);
  const sdk = deps.sdk ?? (() => Number(Platform.Version));
  const askNotifications = deps.askNotifications ?? requestPushPermission;
  const active = () => (os() === 'android' ? getModule() : null);

  const bubble: VoiceBubble = {
    isSupported: () => active()?.isSupported() ?? false,
    isEnabled: async () => active()?.isEnabled() ?? false,
    canDrawOverlays: () => active()?.canDrawOverlays() ?? false,
    openOverlaySettings: () => active()?.openOverlaySettings(),
    setEnabled: async (on) => {
      const module = active();
      if (!module) return false;
      if (!on) {
        module.stop();
        return false;
      }
      if (!module.canDrawOverlays()) return false;
      // The foreground notification needs the runtime permission on Android 13+; the bubble still
      // works when the user says no, so the answer is not checked.
      if (sdk() >= API_TIRAMISU)
        await askNotifications().catch(() => undefined);
      return module.start();
    },
  };

  const tile: VoiceTile = {
    isSupported: () => active() !== null && sdk() >= API_TIRAMISU,
    requestAdd: async () => (await active()?.requestAddTile()) ?? false,
  };

  return { bubble, tile };
}

/** Sends the app to the back after a bubble-started sale; false when there is nothing to do. */
export function moveTaskToBack(
  module: () => NativeVoiceBubble | null = nativeVoiceBubble,
) {
  return module()?.moveTaskToBack() ?? false;
}
