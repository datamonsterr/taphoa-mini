import { memo } from 'react';
import {
  StyleSheet,
  Text as RNText,
  type TextProps,
  type TextStyle,
} from 'react-native';

import { scaleText, typography, useFontScale, type TextVariant } from '@/theme';

export type ScaledTextProps = TextProps & { variant?: TextVariant };

/** `Text` in a typography variant, scaled by the user's text-size setting. */
export const ScaledText = memo(function ScaledText({
  variant = 'body',
  style,
  ...rest
}: ScaledTextProps) {
  const scale = useFontScale();
  return (
    <RNText
      {...rest}
      style={scaleText(
        StyleSheet.flatten([typography[variant], style]) as TextStyle,
        scale,
      )}
    />
  );
});

/** Drop-in for react-native `Text` whose `fontSize` / `lineHeight` follow the user's text size. */
export const Text = memo(function Text({ style, ...rest }: TextProps) {
  const scale = useFontScale();
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  return (
    <RNText
      {...rest}
      style={scale === 1 || !flat ? style : scaleText(flat, scale)}
    />
  );
});
