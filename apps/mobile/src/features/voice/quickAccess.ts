/**
 * Capability checks for the system entry points. V2 ships the interfaces with "unsupported"
 * defaults; V3 replaces them with the native module (Android bubble and Quick Settings tile).
 */
export type VoiceBubble = {
  isSupported: () => boolean;
  isEnabled: () => Promise<boolean>;
  /** Turns the floating button on or off; resolves with the state it ended in. */
  setEnabled: (on: boolean) => Promise<boolean>;
};

export type VoiceTile = {
  isSupported: () => boolean;
  /** Asks the system to add the Quick Settings tile. */
  requestAdd: () => Promise<boolean>;
};

const unsupportedBubble: VoiceBubble = {
  isSupported: () => false,
  isEnabled: async () => false,
  setEnabled: async () => false,
};
const unsupportedTile: VoiceTile = {
  isSupported: () => false,
  requestAdd: async () => false,
};

export let voiceBubble: VoiceBubble = unsupportedBubble;
export let voiceTile: VoiceTile = unsupportedTile;

/** V3 hook point; pass nothing to restore the unsupported defaults. */
export function setVoiceQuickAccess(
  next: { bubble?: VoiceBubble; tile?: VoiceTile } = {},
) {
  voiceBubble = next.bubble ?? unsupportedBubble;
  voiceTile = next.tile ?? unsupportedTile;
}
