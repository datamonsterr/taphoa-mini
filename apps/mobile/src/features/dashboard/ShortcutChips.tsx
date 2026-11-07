import { router, type Href } from 'expo-router';
import { BookOpen, ReceiptText } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { useReceipts } from '@/lib/api';
import type { DebtSummary } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { dashboardStrings } from './strings';

/**
 * Board 10: two half-width shortcut chips under the digest card, each with a count badge.
 * "Sổ nợ" opens the debt book and counts overdue customers (red); "Hóa đơn" opens the import
 * receipts and counts drafts (amber), for members who can enroll. Debts belong to every member,
 * so a Seller sees the debt chip too. A chip stays out while its data loads or fails, and the
 * report above it is unaffected.
 */
export function ShortcutChips({
  showReceipts,
  debtSummary,
}: {
  showReceipts: boolean;
  debtSummary: DebtSummary | undefined;
}) {
  return (
    <View style={styles.row}>
      <DebtChip summary={debtSummary} />
      {showReceipts ? <ReceiptsChip /> : null}
    </View>
  );
}

function DebtChip({ summary }: { summary: DebtSummary | undefined }) {
  const t = useT(dashboardStrings);
  if (!summary) return null;
  const { total_outstanding, overdue_count } = summary;
  const overdue = fill(t('debtsOverdue'), { count: overdue_count });
  const open = () => router.push('/debts' as Href);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={
        t('debts') + ', ' + formatVnd(total_outstanding) + ', ' + overdue
      }
      pressedScale={0.98}
      onPress={open}
      style={styles.chip}
    >
      <Icon icon={BookOpen} />
      <Text style={styles.label} numberOfLines={1}>
        {t('debts')}
      </Text>
      {overdue_count > 0 ? (
        <View style={[styles.badge, styles.badgeDanger]}>
          <Text style={[styles.badgeText, { color: colors.danger }]}>
            {overdue_count}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

function ReceiptsChip() {
  const t = useT(dashboardStrings);
  const drafts = useReceipts('draft');
  const count = drafts.data?.length ?? 0;
  const open = () => router.push('/receipts' as Href);
  return (
    <PressableScale
      testID="dashboard-receipts-chip"
      accessibilityRole="button"
      accessibilityLabel={t('receipts')}
      onPress={open}
      style={styles.chip}
    >
      <Icon icon={ReceiptText} color={colors.ink} />
      <Text style={styles.label} numberOfLines={1}>
        {t('receiptsShort')}
      </Text>
      {count > 0 ? (
        <View style={[styles.badge, styles.badgeWarning]}>
          <Text style={[styles.badgeText, { color: colors.warning }]}>
            {count}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[3] },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: size.tapLg,
    paddingLeft: 18,
    paddingRight: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  label: { ...typography.label, color: colors.ink, flex: 1 },
  badge: {
    minWidth: 28,
    height: 28,
    paddingHorizontal: space[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  badgeDanger: { backgroundColor: colors.dangerSoft },
  badgeWarning: { backgroundColor: colors.warningSoft },
  badgeText: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    fontVariant: ['tabular-nums'],
  },
});
