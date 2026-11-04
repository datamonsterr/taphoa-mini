import { router, type Href } from 'expo-router';
import { Sun } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { useDigest } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { digestStrings } from './strings';

/**
 * Morning digest card on the dashboard (board 10): sun icon, title, a one-line subtitle
 * "Hôm qua {revenue} · {n} món cần nhập" and the "Mới" badge on the right.
 * Stays hidden while loading, on error, or when there is no digest for today. Reading it here
 * never marks it read; only opening the digest screen does.
 */
export function DigestCard() {
  const t = useT(digestStrings);
  const digest = useDigest();

  if (!digest.data) return null;

  const { read_at, sales, restock } = digest.data;
  const isNew = read_at === null;
  const label = t('cardLabel');
  const newLabel = t('newBadge');
  const yesterday = fill(t('cardYesterday'), {
    revenue: formatVnd(sales.revenue),
  });
  const restockText =
    restock.length > 0
      ? fill(t('cardRestock'), { count: restock.length })
      : t('cardNoRestock');
  const subtitle = yesterday + ' · ' + restockText;
  // The label never ends with the money text: on the web the product tiles are selected by an
  // aria-label ending in "đ", and this card sits in the same document as the stock grid.
  const accessibilityLabel =
    label +
    (isNew ? ', ' + t('newSpoken') : '') +
    ', ' +
    yesterday +
    ', ' +
    restockText;
  const open = () => router.push('/digest?entry=card' as Href);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      pressedScale={0.98}
      onPress={open}
      style={styles.card}
    >
      <Icon icon={Sun} color={colors.accent} />
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.caption} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      {isNew ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{newLabel}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  text: { flex: 1, minWidth: 0 },
  label: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  badge: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  badgeText: {
    ...typography.caption,
    color: colors.onAccent,
    fontFamily: fontFamily.semibold,
  },
});
