/**
 * Capability checks for the system entry points. The defaults are backed by the Android native
 * module (modules/voice-bubble) and report "unsupported" wherever it is missing (iOS, web, Expo Go).
 */
import { nativeQuickAccess } from './nativeQuickAccess';

export type VoiceBubble = {
  isSupported: () => boolean;
  isEnabled: () => Promise<boolean>;
  /** Whether "Hiện trên ứng dụng khác" is granted. */
  canDrawOverlays: () => boolean;
  /** Opens the system screen for "Hiện trên ứng dụng khác". */
  openOverlaySettings: () => void;
  /** Turns the floating button on or off; resolves with the state it ended in. */
  setEnabled: (on: boolean) => Promise<boolean>;
};

export type VoiceTile = {
  isSupported: () => boolean;
  /** Asks the system to add the Quick Settings tile. */
  requestAdd: () => Promise<boolean>;
};

const native = nativeQuickAccess();

export let voiceBubble: VoiceBubble = native.bubble;
export let voiceTile: VoiceTile = native.tile;

/** Test hook; pass nothing to restore the native-backed defaults. */
export function setVoiceQuickAccess(
  next: { bubble?: VoiceBubble; tile?: VoiceTile } = {},
) {
  voiceBubble = next.bubble ?? native.bubble;
  voiceTile = next.tile ?? native.tile;
}
