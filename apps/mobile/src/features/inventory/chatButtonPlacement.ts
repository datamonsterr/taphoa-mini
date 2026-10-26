import { size, space } from '@/theme';

export type ChatPlacement = 'beside' | 'above';

export type Frame = { x: number; y: number; width: number; height: number };

const INSET = space[4];
const GAP = space[3];
/** The pill of `BottomBar` pads 6 dp on each side of its three 56 dp tabs. */
const PILL_PADDING = 6;
const TAB_COUNT = 3;
const PILL_MIN = TAB_COUNT * size.tapMin + 2 * PILL_PADDING;

/** Narrowest window where the pill keeps three 56 dp tabs with the button beside it. */
export const MIN_BESIDE_WIDTH =
  INSET + size.tapLg + GAP + PILL_MIN + GAP + size.tapMin + INSET;

/** Beside the pill when it still fits its tabs, otherwise above the right end of the bar. */
export function chatButtonPlacement(windowWidth: number): ChatPlacement {
  return windowWidth >= MIN_BESIDE_WIDTH ? 'beside' : 'above';
}

/**
 * Frames of the bar parts in window x and in y relative to the top of the bar (y grows down), so
 * tests can prove the button covers neither the camera FAB nor a tab target.
 */
export function barFrames(windowWidth: number) {
  const beside = chatButtonPlacement(windowWidth) === 'beside';
  const barWidth = windowWidth - 2 * INSET;
  const pillWidth =
    barWidth - size.tapLg - GAP - (beside ? GAP + size.tapMin : 0);
  const pillX = INSET + size.tapLg + GAP;
  // `space-around` between the pill's paddings.
  const free = pillWidth - 2 * PILL_PADDING - TAB_COUNT * size.tapMin;
  const slot = free / TAB_COUNT;
  const tabY = (size.tapLg - size.tapMin) / 2;
  const tabs = Array.from({ length: TAB_COUNT }, (_, i) => ({
    x: pillX + PILL_PADDING + slot / 2 + i * (slot + size.tapMin),
    y: tabY,
    width: size.tapMin,
    height: size.tapMin,
  }));
  return {
    bar: { x: INSET, y: 0, width: barWidth, height: size.tapLg },
    fab: { x: INSET, y: 0, width: size.tapLg, height: size.tapLg },
    tabs,
    chat: {
      x: windowWidth - INSET - size.tapMin,
      y: beside ? (size.tapLg - size.tapMin) / 2 : -(GAP + size.tapMin),
      width: size.tapMin,
      height: size.tapMin,
    },
  };
}
