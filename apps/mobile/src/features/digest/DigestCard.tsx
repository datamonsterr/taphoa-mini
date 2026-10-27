import { router, type Href } from 'expo-router';
import { ChevronRight, Sparkles } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, MoneyText, PressableScale, Text } from '@/components/ui';
import { useDigest } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { digestStrings } from './strings';
import { buildDigestCaption, firstSentence } from './utils';

/**
 * Morning digest card on the dashboard, shown directly above DebtCard.
 * Stays hidden while loading, on error, or when there is no digest for today.
 */
export function DigestCard() {
  const t = useT(digestStrings);
  const digest = useDigest();

  if (!digest.data) return null;

  const { read_at, summary_vi, sales, restock, overdue_debts } = digest.data;
  const sentence = firstSentence(summary_vi);
  const caption = buildDigestCaption(restock.length, overdue_debts.count, t);
  const label = t('cardLabel');
  const revenueFormatted = formatVnd(sales.revenue);
  // The label never ends with the money text: on the web the product tiles are selected by an
  // aria-label ending in "đ", and this card sits in the same document as the stock grid.
  const accessibilityLabel = `${label}, ${revenueFormatted}, ${caption || sentence}`;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      pressedScale={0.98}
      onPress={() => router.push('/digest?entry=card' as Href)}
      style={styles.card}
    >
      <View style={styles.topRow}>
        <Icon icon={Sparkles} color={colors.accent} />
        <View style={styles.headerTitleRow}>
          <Text style={styles.label}>{label}</Text>
          {read_at === null ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{t('newBadge')}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.spacer} />
        <MoneyText amount={sales.revenue} variant="heading" />
        <Icon icon={ChevronRight} color={colors.inkMuted} />
      </View>
      <Text numberOfLines={2} style={styles.summary}>
        {sentence}
      </Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space[2],
    minHeight: size.tapLg,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  label: { ...typography.label, color: colors.ink },
  badge: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  badgeText: {
    ...typography.caption,
    color: colors.accent,
    fontFamily: fontFamily.semibold,
  },
  spacer: { flex: 1 },
  summary: {
    ...typography.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  caption: {
    ...typography.caption,
    color: colors.inkMuted,
  },
});
