import { TriangleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { strings } from '@/features/stock/strings';
import type { Product } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';

import { Icon } from './Icon';
import { Text } from './ScaledText';

export type StockBadgeProps = {
  quantity: number | null;
  status: Product['stock_status'];
  /** On a product photo the normal chip is white; elsewhere it is the soft grey. */
  onPhoto?: boolean;
};

export const StockBadge = memo(function StockBadge({
  quantity,
  status,
  onPhoto = false,
}: StockBadgeProps) {
  const t = useT(strings);
  if (quantity === null || status === 'untracked') return null;
  const color =
    status === 'out'
      ? colors.danger
      : status === 'low'
        ? colors.warning
        : colors.ink;
  const backgroundColor =
    status === 'out'
      ? colors.dangerSoft
      : status === 'low'
        ? colors.warningSoft
        : onPhoto
          ? colors.surface
          : colors.surfaceSoft;
  return (
    <View
      accessible
      accessibilityLabel={`${t('stock')} ${quantity}, ${t(status)}`}
      style={[styles.badge, { backgroundColor }]}
    >
      {status === 'low' ? (
        <Icon icon={TriangleAlert} size={18} color={color} />
      ) : null}
      <Text style={[styles.text, { color }]}>{quantity}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    minHeight: 32,
    borderRadius: radius.full,
    paddingHorizontal: space[3],
  },
  /** Board chip: 15/20 at weight 600, the count only. The status is the colour, the icon and the label. */
  text: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
});
