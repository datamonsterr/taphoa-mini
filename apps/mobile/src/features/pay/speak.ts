import * as Speech from 'expo-speech';
import { useEffect } from 'react';

import { vndToWords } from '@/lib/vndWords';

const LANGUAGE = 'vi-VN';

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
    if (enabled && change > 0) say(changePhrase(change));
  }, [enabled, change]);
  useEffect(
    () => () => {
      void Speech.stop();
    },
    [],
  );
}
