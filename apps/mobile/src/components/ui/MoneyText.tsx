import { memo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet } from 'react-native';

import { Text } from './ScaledText';

import { formatVnd } from '@/lib/format';
import type { TextVariant } from '@/theme';
import { colors, typography } from '@/theme';

export type MoneyTextProps = {
  amount: number;
  variant?: TextVariant;
  color?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
};

/** VND amount ("12.000đ") in a typography variant, tabular digits. Never wraps. */
export const MoneyText = memo(function MoneyText({
  amount,
  variant = 'price',
  color = colors.ink,
  style,
  testID,
}: MoneyTextProps) {
  return (
    <Text
      testID={testID}
      numberOfLines={1}
      style={[typography[variant], styles.tabular, { color }, style]}
    >
      {formatVnd(amount)}
    </Text>
  );
});

const styles = StyleSheet.create({
  tabular: { fontVariant: ['tabular-nums'] },
});
