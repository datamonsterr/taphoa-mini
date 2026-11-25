import { capture } from '@/lib/analytics';

import { voiceFixturesEnabled } from '../voice/fixture';
import type { QuickPoint } from './quickEnroll';

/**
 * One-trip enrollment (roadmap R4, split from #301): one shutter press takes the angles, each is
 * cut out from a centre point in the background, and the sheet opens at once for name and price
 * (spoken or typed). Off by default: `EXPO_PUBLIC_ONE_TRIP_ENROLL=1` turns it on in a build;
 * development and e2e builds also honour the camera route param `one_trip=1`.
 */
export function oneTripEnabled(param: string | undefined): boolean {
  return (
    process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL === '1' ||
    (param === '1' && voiceFixturesEnabled())
  );
}

/** Angles taken per shutter press; the server needs at least this many references. */
export const ONE_TRIP_SHOTS = 3;
/** Pause between angles: time for the seller to turn the product. */
export const ONE_TRIP_GAP_MS = 700;

/** The seller holds the product in the middle of the frame: prompt SAM there. */
export const centerPoint = (width: number, height: number): QuickPoint => ({
  x: Math.round(width / 2),
  y: Math.round(height / 2),
  label: 1,
});

// --- Spoken name and price -------------------------------------------------------------------

const DIGITS: Record<string, number> = {
  không: 0,
  một: 1,
  mốt: 1,
  hai: 2,
  ba: 3,
  bốn: 4,
  tư: 4,
  năm: 5,
  lăm: 5,
  nhăm: 5,
  sáu: 6,
  bảy: 7,
  bẩy: 7,
  tám: 8,
  chín: 9,
};
const SCALES: Record<string, number> = {
  nghìn: 1000,
  ngàn: 1000,
  chục: 10_000,
  triệu: 1_000_000,
};
const FILLERS = new Set(['linh', 'lẻ', 'đồng', 'đ']);
const NUMERIC = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(k|đ)?$/;

const isPriceWord = (word: string) =>
  word in DIGITS ||
  word in SCALES ||
  FILLERS.has(word) ||
  word === 'mười' ||
  word === 'mươi' ||
  word === 'trăm' ||
  word === 'rưỡi' ||
  NUMERIC.test(word);

/** Evaluates spoken price words; undefined when they do not name an amount in đồng. */
function priceOf(words: string[]): number | undefined {
  let total = 0;
  let hundreds = 0;
  let current = 0;
  let lastScale = 0;
  let scaled = false;
  for (const word of words) {
    const numeric = NUMERIC.exec(word);
    if (numeric) {
      const value = Number(numeric[1]!.replace(/[.,]/g, ''));
      if (numeric[2] === 'k') {
        total += value * 1000;
        lastScale = 1000;
        scaled = true;
      } else {
        current += value;
        if (value >= 1000) scaled = true;
      }
    } else if (word in DIGITS) current += DIGITS[word]!;
    else if (word === 'mười') current += 10;
    else if (word === 'mươi') current *= 10;
    else if (word === 'trăm') {
      hundreds += current * 100;
      current = 0;
    } else if (word in SCALES) {
      const scale = SCALES[word]!;
      total += (hundreds + current || 1) * scale;
      hundreds = current = 0;
      lastScale = scale;
      scaled = true;
    } else if (word === 'rưỡi' && lastScale) total += lastScale / 2;
  }
  const amount = total + hundreds + current;
  return scaled && amount > 0 ? amount : undefined;
}

const capitalize = (text: string) =>
  text ? text[0]!.toLocaleUpperCase('vi') + text.slice(1) : text;

/**
 * Splits one utterance such as "mì hảo hảo năm nghìn" into a name and a price in đồng. The price
 * is the trailing run of number words; it needs a scale word ("nghìn", "chục", "k"…) or at least
 * four digits, so "coca 330" stays a name.
 */
export function parseNamePrice(text: string): { name: string; price?: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let start = words.length;
  while (start > 0 && isPriceWord(words[start - 1]!.toLocaleLowerCase('vi')))
    start--;
  const price = priceOf(
    words.slice(start).map((w) => w.toLocaleLowerCase('vi')),
  );
  if (price === undefined) return { name: capitalize(words.join(' ')) };
  const nameWords = words.slice(0, start);
  if (nameWords.at(-1)?.toLocaleLowerCase('vi') === 'giá') nameWords.pop();
  return { name: capitalize(nameWords.join(' ')), price };
}

// --- Timing (gate C1: one product in 16 s or less) ------------------------------------------

let startedAt: number | undefined;

/** The first shutter press of a one-trip enrollment. */
export function markOneTripStart(): void {
  startedAt = performance.now();
}

export function cancelOneTrip(): void {
  startedAt = undefined;
}

/**
 * The product was saved: logs `enroll.one_trip_completed` (logcat / browser console) and the
 * `one_trip_enrollment_completed` product event with the time since the shutter press.
 */
export function finishOneTrip(props: {
  shot_count: number;
  voice_used: boolean;
}): void {
  if (startedAt === undefined) return;
  const payload = {
    duration_ms: Math.round(performance.now() - startedAt),
    ...props,
  };
  startedAt = undefined;
  console.info('enroll.one_trip_completed', payload);
  capture('one_trip_enrollment_completed', payload);
}
