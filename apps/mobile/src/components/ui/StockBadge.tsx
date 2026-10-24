import { TriangleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { strings } from '@/features/stock/strings';
import type { Product } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { Icon } from './Icon';
import { Text } from './ScaledText';

export type StockBadgeProps = {
  quantity: number | null;
  status: Product['stock_status'];
};

export const StockBadge = memo(function StockBadge({
  quantity,
  status,
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
        : colors.surfaceSoft;
  return (
    <View
      accessible
      accessibilityLabel={`${t('stock')} ${quantity}, ${t(status)}`}
      style={[styles.badge, { backgroundColor }]}
    >
      {status !== 'ok' ? (
        <Icon icon={TriangleAlert} size={16} color={color} />
      ) : null}
      <Text style={[styles.text, { color }]}>{quantity}</Text>
      <Text style={[styles.text, { color }]}>{t(status)}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[1],
    borderRadius: radius.full,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  text: { ...typography.caption, fontVariant: ['tabular-nums'] },
});
