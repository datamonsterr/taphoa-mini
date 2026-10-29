import * as Speech from 'expo-speech';
import { useEffect } from 'react';

import { vndToWords } from '@/lib/vndWords';

const LANGUAGE = 'vi-VN';
/** The change is read only once the cash given stops changing (keypad typing). */
export const CHANGE_SPEAK_DELAY_MS = 800;

export const totalPhrase = (total: number) => `Tổng cộng ${vndToWords(total)}`;
export const changePhrase = (change: number) =>
  `Tiền thối ${vndToWords(change)}`;

/** Speak `text` in Vietnamese, replacing anything still playing. */
function say(text: string) {
  void Speech.stop();
  Speech.speak(text, { language: LANGUAGE });
}

/**
 * Reads the total when the pay sheet opens and the change once the cash given exceeds the
 * total (S7). Silent when `enabled` is off; speech stops on unmount.
 */
export function useSpokenTotal(opts: {
  enabled: boolean;
  total: number;
  /** Change to give back; 0 or less is not spoken. */
  change: number;
}) {
  const { enabled, total, change } = opts;
  useEffect(() => {
    if (enabled && total > 0) say(totalPhrase(total));
  }, [enabled, total]);
  useEffect(() => {
    if (!enabled || change <= 0) return;
    const timer = setTimeout(
      () => say(changePhrase(change)),
      CHANGE_SPEAK_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [enabled, change]);
  useEffect(
    () => () => {
      void Speech.stop();
    },
    [],
  );
}
