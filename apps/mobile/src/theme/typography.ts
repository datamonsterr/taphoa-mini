import type { TextStyle } from 'react-native';

export const fontFamily = {
  regular: 'BeVietnamPro_400Regular',
  medium: 'BeVietnamPro_500Medium',
  semibold: 'BeVietnamPro_600SemiBold',
  bold: 'BeVietnamPro_700Bold',
  extrabold: 'BeVietnamPro_800ExtraBold',
} as const;

/**
 * Font-size scale in dp, keyed by value. The only place numeric font sizes are
 * allowed (ESLint `no-restricted-syntax` enforces it); reach for a variant in
 * `typography` first, then `fontSize[n]` for one-off sizes.
 */
export const fontSize = {
  12: 12,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  17: 17,
  18: 18,
  20: 20,
  22: 22,
  24: 24,
  28: 28,
  30: 30,
  32: 32,
  34: 34,
  40: 40,
  48: 48,
  56: 56,
} as const;

export type TextVariant =
  'total' | 'price' | 'title' | 'heading' | 'body' | 'label' | 'caption';

/** Mirrors the `--text-*` tokens. Weight is carried by the font family. */
export const typography: Record<TextVariant, TextStyle> = {
  total: {
    fontFamily: fontFamily.extrabold,
    fontSize: 56,
    lineHeight: 60,
    letterSpacing: -1,
  },
  price: {
    fontFamily: fontFamily.bold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: 0,
  },
  title: {
    fontFamily: fontFamily.extrabold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: 0,
  },
  heading: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: 0,
  },
  body: {
    fontFamily: fontFamily.regular,
    fontSize: 18,
    lineHeight: 26,
    letterSpacing: 0,
  },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: 0,
  },
  caption: {
    fontFamily: fontFamily.medium,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0,
  },
};
