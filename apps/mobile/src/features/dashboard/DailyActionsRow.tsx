import { BookOpen, Plus, SquareCheck } from '@/components/icons';
import { router, type Href } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { useIsLead } from '@/features/auth/useMembership';
import { useDebtSummary } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, fontSize, radius, size, space } from '@/theme';

import { dashboardStrings } from './strings';

/**
 * Daily actions row on Dashboard (Báo cáo tab):
 * Chi (expense), Chốt sổ (close day, Lead only), and Công nợ (debts).
 * Keeps 48 dp min touch targets and uses theme tokens.
 */
export const DailyActionsRow = memo(function DailyActionsRow() {
  const t = useT(dashboardStrings);
  const isLead = useIsLead();
  const summary = useDebtSummary();

  const totalOutstanding = summary.data?.total_outstanding ?? 0;
  const overdueCount = summary.data?.overdue_count ?? 0;
  const overdueText = fill(t('debtsOverdue'), { count: overdueCount });

  const debtAccessibilityLabel = summary.data
    ? `${t('debts')}, ${formatVnd(totalOutstanding)}, ${overdueText}`
    : t('debts');

  return (
    <View style={styles.row}>
      <PressableScale
        testID="dashboard-add-expense"
        accessibilityRole="button"
        accessibilityLabel={t('addExpense')}
        pressedScale={0.97}
        onPress={() => router.push('/expense')}
        style={styles.cell}
      >
        <Icon icon={Plus} size={20} color={colors.ink} />
        <Text numberOfLines={1} style={styles.label}>
          {t('expense')}
        </Text>
      </PressableScale>

      {isLead ? (
        <PressableScale
          testID="dashboard-close-day"
          accessibilityRole="button"
          accessibilityLabel={t('close')}
          pressedScale={0.97}
          onPress={() => router.push('/close')}
          style={styles.cell}
        >
          <Icon icon={SquareCheck} size={20} color={colors.ink} />
          <Text numberOfLines={1} style={styles.label}>
            {t('close')}
          </Text>
        </PressableScale>
      ) : null}

      <PressableScale
        testID="dashboard-debts"
        accessibilityRole="button"
        accessibilityLabel={debtAccessibilityLabel}
        pressedScale={0.97}
        onPress={() => router.push('/debts' as Href)}
        style={styles.cell}
      >
        <Icon icon={BookOpen} size={20} color={colors.ink} />
        <Text numberOfLines={1} style={styles.label}>
          {t('debts')}
        </Text>
        {overdueCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{overdueCount}</Text>
          </View>
        ) : null}
      </PressableScale>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space[2],
  },
  cell: {
    flex: 1,
    minHeight: size.tapLg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize[15],
    lineHeight: 20,
    color: colors.ink,
    flexShrink: 1,
  },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: space[1],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.dangerSoft,
  },
  badgeText: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize[12],
    lineHeight: 16,
    color: colors.danger,
    fontVariant: ['tabular-nums'],
  },
});
