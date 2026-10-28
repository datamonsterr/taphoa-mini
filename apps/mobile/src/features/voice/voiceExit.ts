/**
 * What happens when the voice sheet is done (a sale confirmed, or the sheet closed). V3 replaces
 * the default with the Android `moveTaskToBack` when the sheet was opened from the bubble.
 */
export type VoiceExit = {
  /** Called once when the sheet finishes; `close` dismisses the sheet inside the app. */
  onDone: (context: { returnToPrevious: boolean }, close: () => void) => void;
};

const defaultExit: VoiceExit = { onDone: (_context, close) => close() };

let current: VoiceExit = defaultExit;

export const voiceExit: VoiceExit = {
  onDone: (context, close) => current.onDone(context, close),
};

/** V3 hook point: swap the exit (pass null to restore the default). */
export function setVoiceExit(next: VoiceExit | null) {
  current = next ?? defaultExit;
}
