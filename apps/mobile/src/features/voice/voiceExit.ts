import { moveTaskToBack } from './nativeQuickAccess';

/**
 * What happens when the voice sheet is done (a sale confirmed, or the sheet closed). When the
 * sheet was opened from the Android bubble the app also goes to the back, so the previous app
 * returns (`moveTaskToBack` in modules/voice-bubble).
 */
export type VoiceExit = {
  /** Called once when the sheet finishes; `close` dismisses the sheet inside the app. */
  onDone: (context: { returnToPrevious: boolean }, close: () => void) => void;
};

const defaultExit: VoiceExit = {
  onDone: (context, close) => {
    close();
    if (context.returnToPrevious) moveTaskToBack();
  },
};

let current: VoiceExit = defaultExit;

export const voiceExit: VoiceExit = {
  onDone: (context, close) => current.onDone(context, close),
};

/** V3 hook point: swap the exit (pass null to restore the default). */
export function setVoiceExit(next: VoiceExit | null) {
  current = next ?? defaultExit;
}
