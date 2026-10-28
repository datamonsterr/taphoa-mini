import { requireOptionalNativeModule } from 'expo';

/** The Kotlin module (Android only). Missing on iOS, web, Expo Go and before a native rebuild. */
export type NativeVoiceBubble = {
  isSupported(): boolean;
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  isEnabled(): boolean;
  isRunning(): boolean;
  /** false when the overlay permission is missing */
  start(): boolean;
  stop(): void;
  requestAddTile(): Promise<boolean>;
  moveTaskToBack(): boolean;
};

export const nativeVoiceBubble = (): NativeVoiceBubble | null =>
  requireOptionalNativeModule<NativeVoiceBubble>('VoiceBubble');
