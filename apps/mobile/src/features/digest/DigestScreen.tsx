import { router, useLocalSearchParams, type Href } from 'expo-router';
import {
  BookUser,
  ChevronLeft,
  ChevronRight,
  ReceiptText,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react-native';
import { useCallback, useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CircleButton,
  Icon,
  MoneyText,
  PressableScale,
  Text,
} from '@/components/ui';
import { capture } from '@/lib/analytics';
import { useDigest } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { digestStrings } from './strings';
import { formatDayMonth } from './utils';

export function DigestScreen() {
  const t = useT(digestStrings);
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    entry?: string;
    business_date?: string;
  }>();

  useEffect(() => {
    capture('digest_opened', {
      entry: params.entry === 'push' ? 'push' : 'card',
    });
  }, [params.entry]);

  const {
    data: digest,
    isPending,
    isError,
    refetch,
  } = useDigest(params.business_date);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const openDebts = useCallback(() => router.push('/debts' as Href), []);
  const openDrafts = useCallback(() => router.push('/receipts' as Href), []);
  const askAssistant = useCallback(() => {
    router.push({
      pathname: '/assistant',
      params: {
        entry: 'digest',
        screen: 'digest',
        prompt: t('assistantPrompt'),
      },
    } as Href);
  }, [t]);

  const dateStr = digest?.business_date ?? params.business_date;
  const formattedDate = dateStr ? formatDayMonth(dateStr) : '';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: space[4] + insets.top,
          paddingBottom: space[8] + insets.bottom,
        },
      ]}
    >
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={t('back')}
          onPress={goBack}
        />
        <View style={styles.headerTitleWrap}>
          <Text accessibilityRole="header" style={styles.title}>
            {t('title')}
          </Text>
          {formattedDate ? (
            <Text style={styles.date}>{formattedDate}</Text>
          ) : null}
        </View>
      </View>

      {isError ? (
        <View accessibilityRole="alert" style={styles.errorBox}>
          <Text style={styles.errorText}>{t('error')}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            pressedScale={0.96}
            onPress={() => void refetch()}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : isPending ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={t('loading')}
          style={styles.loadingContainer}
        >
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : digest ? (
        <View style={styles.body}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryText}>{digest.summary_vi}</Text>
          </View>

          {/* Stat rows */}
          <View style={styles.section}>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>{t('revenue')}</Text>
              <MoneyText amount={digest.sales.revenue} variant="heading" />
            </View>

            <View style={styles.statRow}>
              <Text style={styles.statLabel}>{t('saleCount')}</Text>
              <Text style={styles.statValue}>{digest.sales.sale_count}</Text>
            </View>

            {digest.sales.gross_profit !== null ? (
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{t('grossProfit')}</Text>
                <MoneyText
                  amount={digest.sales.gross_profit}
                  variant="heading"
                />
              </View>
            ) : null}

            {digest.sales.change_pct !== null ? (
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{t('changeVsYesterday')}</Text>
                <View style={styles.changeBadge}>
                  {digest.sales.change_pct > 0 ? (
                    <Icon icon={TrendingUp} size={18} color={colors.success} />
                  ) : digest.sales.change_pct < 0 ? (
                    <Icon icon={TrendingDown} size={18} color={colors.danger} />
                  ) : null}
                  <Text
                    style={[
                      styles.changeText,
                      digest.sales.change_pct > 0 && styles.changePositive,
                      digest.sales.change_pct < 0 && styles.changeNegative,
                    ]}
                  >
                    {digest.sales.change_pct > 0 ? '+' : ''}
                    {digest.sales.change_pct}%
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          {/* Restock list */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('restockTitle')}</Text>
            {digest.restock.length === 0 ? (
              <Text style={styles.emptyText}>{t('restockEmpty')}</Text>
            ) : (
              <View style={styles.restockList}>
                {digest.restock.map((item) => (
                  <View key={item.product_id} style={styles.restockItem}>
                    <View style={styles.restockInfo}>
                      <Text style={styles.restockName}>{item.name}</Text>
                      <Text style={styles.restockQuantity}>
                        × {item.quantity}
                      </Text>
                    </View>
                    {item.total_cost !== null ? (
                      <MoneyText amount={item.total_cost} variant="label" />
                    ) : null}
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Overdue debts row */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${t('overdueDebts')}, ${digest.overdue_debts.count}, ${formatVnd(digest.overdue_debts.total)}`}
            pressedScale={0.98}
            onPress={openDebts}
            style={styles.actionRow}
          >
            <Icon icon={BookUser} color={colors.ink} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>{t('overdueDebts')}</Text>
              <Text style={styles.actionCaption}>
                {fill(t('overdueCount'), {
                  count: digest.overdue_debts.count,
                })}
              </Text>
            </View>
            <MoneyText amount={digest.overdue_debts.total} variant="heading" />
            <Icon icon={ChevronRight} color={colors.inkMuted} />
          </PressableScale>

          {/* Open drafts row */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${t('openDrafts')}, ${digest.open_drafts.count}`}
            pressedScale={0.98}
            onPress={openDrafts}
            style={styles.actionRow}
          >
            <Icon icon={ReceiptText} color={colors.ink} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>{t('openDrafts')}</Text>
              <Text style={styles.actionCaption}>
                {fill(t('openDraftsCount'), {
                  count: digest.open_drafts.count,
                })}
              </Text>
            </View>
            <Icon icon={ChevronRight} color={colors.inkMuted} />
          </PressableScale>

          {/* Primary Ask Assistant Button */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('askAssistant')}
            pressedScale={0.97}
            onPress={askAssistant}
            style={styles.primaryButton}
          >
            <Icon icon={Sparkles} color={colors.onInk} />
            <Text style={styles.primaryButtonText}>{t('askAssistant')}</Text>
          </PressableScale>
        </View>
      ) : (
        <View accessibilityRole="alert" style={styles.emptyBox}>
          <Text style={styles.emptyText}>{t('noDigest')}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: space[4] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  headerTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { ...typography.heading, color: colors.ink },
  date: {
    ...typography.caption,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  loadingContainer: {
    paddingVertical: space[8],
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.dangerSoft,
    gap: space[3],
    alignItems: 'center',
  },
  errorText: { ...typography.body, color: colors.danger, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  retryText: { ...typography.label, color: colors.ink },
  emptyBox: {
    padding: space[6],
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { gap: space[4] },
  summaryCard: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  summaryText: {
    ...typography.body,
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
  },
  section: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
    gap: space[3],
  },
  sectionTitle: { ...typography.label, color: colors.ink },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statLabel: { ...typography.body, color: colors.inkMuted },
  statValue: {
    ...typography.heading,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  changeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  changeText: {
    ...typography.label,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  changePositive: { color: colors.success },
  changeNegative: { color: colors.danger },
  restockList: { gap: space[2] },
  restockItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[1],
  },
  restockInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    flex: 1,
  },
  restockName: { ...typography.body, color: colors.ink },
  restockQuantity: {
    ...typography.caption,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  emptyText: { ...typography.caption, color: colors.inkMuted },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapLg,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  actionText: { flex: 1 },
  actionTitle: { ...typography.label, color: colors.ink },
  actionCaption: { ...typography.caption, color: colors.inkMuted },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: 56,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
    marginTop: space[2],
  },
  primaryButtonText: { ...typography.label, color: colors.onInk },
});
