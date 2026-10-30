import { router, useLocalSearchParams, type Href } from 'expo-router';
import {
  BookUser,
  ChevronLeft,
  DollarSign,
  MessageCircleText,
  ReceiptText,
  Sun,
  TrendingDown,
  TrendingUp,
} from 'lucide-react-native';
import { useCallback, useEffect, type ReactNode } from 'react';
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
import { formatVnd } from '@/lib/format';
import { useOpenDigest } from '@/lib/api';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { digestStrings } from './strings';
import { formatDigestStamp, summarySegments } from './utils';

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

  // Opening the digest is what marks it read; the dashboard card only peeks.
  const {
    data: digest,
    isPending,
    isError,
    refetch,
  } = useOpenDigest(params.business_date);

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
    });
  }, [t]);

  const dateStr = digest?.business_date ?? params.business_date;
  const stamp = dateStr ? formatDigestStamp(dateStr, digest?.generated_at) : '';
  const title = t('title');
  const backLabel = t('back');
  const retryLabel = t('retry');
  const errorText = t('error');
  const loadingLabel = t('loading');
  const noDigest = t('noDigest');

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
          accessibilityLabel={backLabel}
          onPress={goBack}
        />
        <View style={styles.headerTitleWrap}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {stamp ? <Text style={styles.date}>{stamp}</Text> : null}
        </View>
        <Icon icon={Sun} color={colors.accent} />
      </View>

      {isError ? (
        <View accessibilityRole="alert" style={styles.errorBox}>
          <Text style={styles.errorText}>{errorText}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
            pressedScale={0.96}
            onPress={() => void refetch()}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>{retryLabel}</Text>
          </PressableScale>
        </View>
      ) : isPending ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={loadingLabel}
          style={styles.loadingContainer}
        >
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : digest ? (
        <View style={styles.body}>
          <Text style={styles.summaryText}>
            {summarySegments(digest.summary_vi).map((part, index) => (
              <Text
                key={index}
                style={part.bold ? styles.summaryBold : undefined}
              >
                {part.text}
              </Text>
            ))}
          </Text>

          <View style={styles.tiles}>
            <Tile
              icon={TrendingUp}
              label={t('revenue')}
              spoken={formatVnd(digest.sales.revenue)}
            >
              <MoneyText
                amount={digest.sales.revenue}
                variant="heading"
                style={styles.tileValue}
              />
            </Tile>
            <Tile
              icon={ReceiptText}
              label={t('saleCount')}
              spoken={fill(t('ordersCount'), {
                count: digest.sales.sale_count,
              })}
            >
              <Text style={styles.tileValue}>
                {fill(t('ordersCount'), { count: digest.sales.sale_count })}
              </Text>
            </Tile>
            {digest.sales.gross_profit !== null ? (
              <Tile
                icon={DollarSign}
                label={t('grossProfit')}
                spoken={formatVnd(digest.sales.gross_profit)}
                tone="success"
              >
                <MoneyText
                  amount={digest.sales.gross_profit}
                  variant="heading"
                  color={colors.success}
                  style={styles.tileValue}
                />
              </Tile>
            ) : null}
            {digest.sales.change_pct !== null ? (
              <Tile
                icon={digest.sales.change_pct < 0 ? TrendingDown : TrendingUp}
                label={t('changeVsYesterday')}
                spoken={changeText(digest.sales.change_pct)}
                tone={
                  digest.sales.change_pct > 0
                    ? 'success'
                    : digest.sales.change_pct < 0
                      ? 'danger'
                      : undefined
                }
              >
                <Text
                  style={[
                    styles.tileValue,
                    digest.sales.change_pct > 0 && styles.positive,
                    digest.sales.change_pct < 0 && styles.negative,
                  ]}
                >
                  {changeText(digest.sales.change_pct)}
                </Text>
              </Tile>
            ) : null}
          </View>

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

          <View style={styles.chips}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={
                t('openDrafts') + ', ' + digest.open_drafts.count
              }
              pressedScale={0.98}
              onPress={openDrafts}
              style={styles.chip}
            >
              <Icon icon={ReceiptText} color={colors.ink} />
              <Text style={styles.chipText} numberOfLines={2}>
                {fill(t('draftsChip'), { count: digest.open_drafts.count })}
              </Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={
                t('overdueDebts') + ', ' + digest.overdue_debts.count
              }
              pressedScale={0.98}
              onPress={openDebts}
              style={[
                styles.chip,
                digest.overdue_debts.count > 0 && styles.chipDanger,
              ]}
            >
              <Icon
                icon={BookUser}
                color={
                  digest.overdue_debts.count > 0 ? colors.danger : colors.ink
                }
              />
              <Text
                style={[
                  styles.chipText,
                  digest.overdue_debts.count > 0 && styles.negative,
                ]}
                numberOfLines={2}
              >
                {fill(t('overdueChip'), { count: digest.overdue_debts.count })}
              </Text>
            </PressableScale>
          </View>

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('askAssistant')}
            pressedScale={0.97}
            onPress={askAssistant}
            style={styles.primaryButton}
          >
            <Icon icon={MessageCircleText} color={colors.onInk} />
            <Text style={styles.primaryButtonText}>{t('askAssistant')}</Text>
          </PressableScale>
        </View>
      ) : (
        <View accessibilityRole="alert" style={styles.emptyBox}>
          <Text style={styles.emptyText}>{noDigest}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const changeText = (pct: number) => (pct > 0 ? '+' : '') + pct + '%';

type TileProps = {
  icon: typeof TrendingUp;
  label: string;
  spoken: string;
  tone?: 'success' | 'danger';
  children: ReactNode;
};

/** Board stat tile: icon over the figure, half width, soft tone for profit and change. */
function Tile({ icon, label, spoken, tone, children }: TileProps) {
  const iconColor =
    tone === 'success'
      ? colors.success
      : tone === 'danger'
        ? colors.danger
        : colors.inkMuted;
  return (
    <View
      accessible
      accessibilityLabel={label + ' ' + spoken}
      style={[
        styles.tile,
        tone === 'success' && styles.tileSuccess,
        tone === 'danger' && styles.tileDanger,
      ]}
    >
      <View style={styles.tileIcon}>
        <Icon icon={icon} color={iconColor} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: space[4] },
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  headerTitleWrap: { flex: 1, minWidth: 0 },
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
  summaryText: { ...typography.body, color: colors.ink },
  summaryBold: { fontFamily: fontFamily.bold },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    // Two per row even when the count is odd: a lone last tile keeps the half width.
    maxWidth: '48%',
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  tileSuccess: { backgroundColor: colors.successSoft },
  tileDanger: { backgroundColor: colors.dangerSoft },
  tileIcon: { height: 33 },
  tileValue: {
    marginTop: 4,
    fontFamily: fontFamily.extrabold,
    fontSize: 22,
    lineHeight: 28,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  positive: { color: colors.success },
  negative: { color: colors.danger },
  sectionTitle: {
    ...typography.heading,
    color: colors.ink,
    marginTop: space[1],
  },
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
  chips: { flexDirection: 'row', gap: space[3] },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  chipDanger: { backgroundColor: colors.dangerSoft },
  chipText: { ...typography.label, color: colors.ink, flex: 1 },
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
