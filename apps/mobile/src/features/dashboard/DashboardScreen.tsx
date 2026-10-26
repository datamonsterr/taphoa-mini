import { router, type Href } from 'expo-router';
import { Plus, ReceiptText, SquareCheck } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CircleButton,
  Icon,
  PeriodChips,
  PressableScale,
  type Period,
  Text,
} from '@/components/ui';
import { useLabels, useT } from '@/lib/i18n';
import {
  selectCanEnroll,
  selectIsLead,
  useSessionStore,
} from '@/stores/session';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { AlertsSection } from './AlertsSection';
import { BarChart } from './BarChart';
import { DebtCard } from './DebtCard';
import { DigestCard } from '@/features/digest/DigestCard';
import { StatTiles } from './StatTiles';
import { dashboardStrings } from './strings';
import { useDashboardData } from './useDashboardData';

/** Space under the content for the floating bottom bar (board: 112). */
const BAR_CLEARANCE = 112;

const periodLabels = (t: (key: string) => string) => ({
  group: t('period.group'),
  day: t('period.day'),
  week: t('period.week'),
  month: t('period.month'),
});

export function DashboardScreen() {
  const t = useT(dashboardStrings);
  const labels = useLabels(dashboardStrings, periodLabels);
  const insets = useSafeAreaInsets();
  const [period, setPeriod] = useState<Period>('day');
  const data = useDashboardData(period);
  const isLead = useSessionStore(selectIsLead);
  const canEnroll = useSessionStore(selectCanEnroll);

  const addExpense = useCallback(() => router.push('/expense'), []);
  const closeDay = useCallback(() => router.push('/close'), []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: space[6] + insets.top,
          paddingBottom: BAR_CLEARANCE + insets.bottom,
        },
      ]}
    >
      <View style={styles.header}>
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={t('screen')}
        >
          <Text style={styles.title}>{t(`title.${period}`)}</Text>
        </View>
        <CircleButton
          icon={Plus}
          accessibilityLabel={t('addExpense')}
          onPress={addExpense}
        />
      </View>

      <PeriodChips value={period} onChange={setPeriod} labels={labels} />

      {data.status === 'loading' ? (
        <View
          testID="dashboard-skeleton"
          accessibilityLabel={t('loading')}
          accessibilityRole="progressbar"
          style={styles.skeleton}
        >
          <View style={styles.skeletonWide} />
          <View style={styles.skeletonTiles}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.skeletonTile} />
            ))}
          </View>
          <View style={styles.skeletonChart} />
        </View>
      ) : null}

      {data.status === 'error' ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{t('error')}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            pressedScale={0.96}
            onPress={data.refetch}
            style={styles.retry}
          >
            <Text style={styles.retryText}>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : null}

      {data.status === 'ready' ? (
        <>
          <StatTiles
            totals={data.totals}
            labels={{
              revenue: t('revenue'),
              orders: t('orders'),
              cash: t('cash'),
              transfer: t('transfer'),
              expense: t('expense'),
              net: t('net'),
            }}
          />
          <BarChart bars={data.bars} label={t(`chart.${period}`)} />
        </>
      ) : null}

      <AlertsSection />

      <DigestCard />
      <DebtCard />

      {canEnroll ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('receipts')}
          onPress={() => router.push('/receipts' as Href)}
          style={styles.receiptsButton}
        >
          <Icon icon={ReceiptText} color={colors.ink} />
          <Text style={styles.retryText}>{t('receipts')}</Text>
        </PressableScale>
      ) : null}

      {isLead ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('close')}
          pressedScale={0.96}
          onPress={closeDay}
          style={styles.closeButton}
        >
          <Icon icon={SquareCheck} color={colors.onInk} />
          <Text style={styles.closeText}>{t('close')}</Text>
        </PressableScale>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  receiptsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: size.tapMin,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { ...typography.title, color: colors.ink },
  skeleton: { gap: space[3] },
  skeletonWide: {
    height: 118,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  skeletonTiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  skeletonTile: {
    flexGrow: 1,
    flexBasis: '45%',
    height: 84,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  skeletonChart: {
    height: 210,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  error: { alignItems: 'center', gap: space[3], paddingVertical: space[6] },
  errorText: { ...typography.label, color: colors.danger },
  retry: {
    minHeight: size.tapMin,
    paddingHorizontal: space[6],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  retryText: { ...typography.label, color: colors.ink },
  closeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: size.tapLg,
    paddingHorizontal: 28,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  closeText: {
    fontFamily: fontFamily.semibold,
    fontSize: 18,
    lineHeight: 24,
    color: colors.onInk,
  },
});
