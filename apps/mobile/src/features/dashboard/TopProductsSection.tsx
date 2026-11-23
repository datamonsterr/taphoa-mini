import { router } from 'expo-router';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { MoneyText, PressableScale, Text, type Period } from '@/components/ui';
import { useTopProducts } from '@/lib/api';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { dashboardStrings } from './strings';
import { currentRange } from './useDashboardData';

const LIMIT = 5;

/** The five best sellers of the selected period; a row opens the product. */
export const TopProductsSection = memo(function TopProductsSection({
  period,
}: {
  period: Period;
}) {
  const t = useT(dashboardStrings);
  const date = businessDate();
  const range = useMemo(
    () => currentRange(period, new Date(date)),
    [period, date],
  );
  const query = useTopProducts(range, LIMIT);
  const items = query.data ?? [];

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('topProducts')}
      </Text>
      {query.isError ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{t('topProductsError')}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            pressedScale={0.96}
            onPress={() => void query.refetch()}
            style={styles.retry}
          >
            <Text style={styles.retryText}>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : query.isPending ? (
        <View
          testID="top-products-skeleton"
          accessibilityLabel={t('loading')}
          style={styles.skeleton}
        />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{t('topProductsEmpty')}</Text>
      ) : (
        <View style={styles.list}>
          {items.map((item) => {
            const name = item.name ?? t('unnamedProduct');
            return (
              <PressableScale
                key={item.product_id}
                accessibilityRole="button"
                accessibilityLabel={`${name}, ${item.quantity} ${t('sold')}, ${formatVnd(item.revenue)}`}
                pressedScale={0.98}
                onPress={() => router.push(`/product/${item.product_id}`)}
                style={styles.row}
              >
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={styles.meta}>
                    {item.quantity} {t('sold')}
                  </Text>
                </View>
                <MoneyText amount={item.revenue} variant="label" />
              </PressableScale>
            );
          })}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  section: { gap: space[2] },
  title: { ...typography.heading, color: colors.ink },
  list: {
    padding: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  row: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  names: { flex: 1 },
  name: { ...typography.label, color: colors.ink },
  meta: { ...typography.caption, color: colors.inkMuted },
  empty: { ...typography.caption, color: colors.inkMuted },
  skeleton: {
    height: 120,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  errorText: { ...typography.caption, color: colors.danger, flex: 1 },
  retry: {
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  retryText: { ...typography.label, color: colors.ink },
});
