import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { MessageCircleText } from '@/components/icons';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CircleButton,
  PeriodChips,
  PressableScale,
  type Period,
  Text,
} from '@/components/ui';
import { useLabels, useT } from '@/lib/i18n';
import { useAssistantEnabled } from '@/features/assistant/flags';
import { assistantHref } from '@/features/assistant/route';
import { voiceHref } from '@/features/voice/route';
import { strings as assistantStrings } from '@/components/assistant/strings';
import { colors, radius, size, space, typography } from '@/theme';

import { AlertsSection } from './AlertsSection';
import { BarChart } from './BarChart';
import { DailyActionsRow } from './DailyActionsRow';
import { DigestCard } from '@/features/digest/DigestCard';
import { StatTiles } from './StatTiles';
import { TopProductsSection } from './TopProductsSection';
import { dashboardStrings } from './strings';
import { useDashboardData } from './useDashboardData';
import { ExportSheet } from './ExportSheet';
import { transactionStrings } from './transactionStrings';

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
  const assistantT = useT(assistantStrings);
  const transactions = useT(transactionStrings);
  const [exporting, setExporting] = useState(false);
  const labels = useLabels(dashboardStrings, periodLabels);
  const insets = useSafeAreaInsets();
  const [period, setPeriod] = useState<Period>('day');
  const data = useDashboardData(period);
  const assistant = useAssistantEnabled();

  const recentLabel = transactions('recent');
  const exportLabel = transactions('export');

  return (
    <View style={{ flex: 1 }}>
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
          {assistant ? (
            <CircleButton
              icon={MessageCircleText}
              accessibilityLabel={assistantT('open')}
              accessibilityHint={assistantT('voiceHint')}
              testID="chat-button"
              onPress={() =>
                router.push(
                  assistantHref({ entry: 'button', screen: 'dashboard' }),
                )
              }
              onLongPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                router.push(voiceHref({ entry: 'longpress' }));
              }}
            />
          ) : null}
        </View>

        <DailyActionsRow />

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

        {data.status === 'error' || data.status === 'offline' ? (
          <View
            testID={`dashboard-${data.status}`}
            accessibilityRole="alert"
            style={styles.error}
          >
            <Text style={styles.errorText}>
              {t(data.status === 'offline' ? 'offline' : 'error')}
            </Text>
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
            <TopProductsSection period={period} />
            <BarChart bars={data.bars} label={t(`chart.${period}`)} />
          </>
        ) : null}

        <AlertsSection />

        <DigestCard />

        <View style={styles.links}>
          <PressableScale
            testID="dashboard-recent-sales"
            accessibilityRole="button"
            accessibilityLabel={recentLabel}
            pressedScale={0.96}
            onPress={() => router.push('/sales')}
            style={styles.link}
          >
            <Text style={styles.linkText}>{recentLabel}</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('recentExpenses')}
            pressedScale={0.96}
            onPress={() => router.push('/expenses')}
            style={styles.link}
          >
            <Text style={styles.linkText}>{t('recentExpenses')}</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={exportLabel}
            pressedScale={0.96}
            onPress={() => setExporting(true)}
            style={styles.link}
          >
            <Text style={styles.linkText}>{exportLabel}</Text>
          </PressableScale>
        </View>
      </ScrollView>
      {exporting ? <ExportSheet onClose={() => setExporting(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  links: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space[4],
  },
  link: {
    minHeight: size.tapMin,
    paddingHorizontal: space[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: { ...typography.label, color: colors.inkMuted },
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
});
