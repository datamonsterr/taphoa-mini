import { useMemo } from 'react';
import type { TextStyle } from 'react-native';

import { useSettingsStore } from '@/stores/settings';
import { typography, type TextVariant } from './typography';

export const FONT_SCALE_MIN = 1;
export const FONT_SCALE_MAX = 2;
export const FONT_SCALE_STEP = 0.25;
/** Elder mode never shows text smaller than this. */
export const ELDER_FONT_SCALE_FLOOR = 1.25;

/** Clamps to 100–200 % and snaps to 25 % steps (the board's stepper). */
export function clampFontScale(scale: number): number {
  const snapped = Math.round(scale / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, snapped));
}

export function stepFontScale(scale: number, direction: 1 | -1): number {
  return clampFontScale(scale + direction * FONT_SCALE_STEP);
}

export const formatScale = (scale: number) => `${Math.round(scale * 100)}%`;

/** Scales `fontSize` and `lineHeight` of a style; other keys pass through. */
export function scaleText(style: TextStyle, scale: number): TextStyle {
  return {
    ...style,
    ...(style.fontSize !== undefined && { fontSize: style.fontSize * scale }),
    ...(style.lineHeight !== undefined && {
      lineHeight: style.lineHeight * scale,
    }),
  };
}

/** Smallest text size the user can pick: 100 %, or 125 % in elder mode. */
export const useMinFontScale = () =>
  useSettingsStore((s) =>
    s.elderMode ? ELDER_FONT_SCALE_FLOOR : FONT_SCALE_MIN,
  );

/** The text-size factor (1–2) in effect: the stored choice, raised to the elder-mode floor. */
export const useFontScale = () =>
  useSettingsStore((s) =>
    s.elderMode ? Math.max(s.fontScale, ELDER_FONT_SCALE_FLOOR) : s.fontScale,
  );

/** `typography` with every variant multiplied by the user's text size. */
export function useScaledTypography(): Record<TextVariant, TextStyle> {
  const scale = useFontScale();
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(typography).map(([key, style]) => [
          key,
          scaleText(style, scale),
        ]),
      ) as Record<TextVariant, TextStyle>,
    [scale],
  );
}
