import { CircleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { colors, fontFamily, radius } from '@/theme';

import { Icon } from './Icon';

export type StockBadgeProps = {
  quantity: number;
  /** Low stock: amber ground with an alert icon. */
  low?: boolean;
};

export const StockBadge = memo(function StockBadge({
  quantity,
  low = false,
}: StockBadgeProps) {
  return (
    <View
      accessible
      accessibilityLabel={low ? `sắp hết: còn ${quantity}` : `còn ${quantity}`}
      style={[styles.badge, low ? styles.low : styles.normal]}
    >
      {low ? (
        <Icon icon={CircleAlert} size={18} color={colors.warning} />
      ) : null}
      <Text style={[styles.text, low && styles.lowText]}>{quantity}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.full,
  },
  normal: { backgroundColor: colors.surface },
  low: { backgroundColor: colors.warningSoft },
  text: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  lowText: { color: colors.warning },
});
