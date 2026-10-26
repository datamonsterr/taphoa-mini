import { router, type Href } from 'expo-router';
import { BookUser, ChevronRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, MoneyText, PressableScale, Text } from '@/components/ui';
import { useDebtSummary } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { dashboardStrings } from './strings';

/**
 * "Sổ nợ": what customers owe the store and how many are overdue; a tap opens the debt book.
 * Debts belong to every member, so a Seller sees it too. It is a side card: while the summary
 * loads or fails it stays out, and the report above it is unaffected.
 */
export function DebtCard() {
  const t = useT(dashboardStrings);
  const summary = useDebtSummary();
  if (!summary.data) return null;
  const { total_outstanding, overdue_count } = summary.data;
  const overdue = fill(t('debtsOverdue'), { count: overdue_count });
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${t('debts')}, ${formatVnd(total_outstanding)}, ${overdue}`}
      pressedScale={0.98}
      onPress={() => router.push('/debts' as Href)}
      style={styles.card}
    >
      <Icon icon={BookUser} />
      <View style={styles.text}>
        <Text style={styles.label}>{t('debts')}</Text>
        <Text
          style={[styles.caption, overdue_count > 0 && styles.captionOverdue]}
        >
          {overdue}
        </Text>
      </View>
      <MoneyText amount={total_outstanding} variant="heading" />
      <Icon icon={ChevronRight} color={colors.inkMuted} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapLg,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  text: { flex: 1 },
  label: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  captionOverdue: { color: colors.warning },
});
