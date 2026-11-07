import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ChevronLeft, TriangleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import { StockBadge } from '@/components/ui/StockBadge';
import { useStock } from '@/lib/api/hooks';
import type { StockStatus } from '@/lib/api/stock';
import { assistantHref } from '@/features/assistant/route';
import { useLowStockItems } from '@/features/stock-alerts/useLowStockItems';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { StockSegment } from './StockSegment';
import { strings } from './strings';

const FILTERS = ['all', 'low', 'out', 'ok'] as const;

export function StockScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<StockStatus>('all');
  const [refreshing, setRefreshing] = useState(false);
  const stock = useStock(status);
  // After the list's own query, so the list is the first request on screen.
  const { items: lowItems } = useLowStockItems();
  const refresh = async () => {
    setRefreshing(true);
    try {
      await stock.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={t('back')}
          onPress={() => router.replace('/inventory')}
        />
        <Text accessibilityRole="header" style={styles.title}>
          {t('stock')}
        </Text>
      </View>
      <StockSegment selected="stock" />
      <View style={styles.filters}>
        {FILTERS.map((filter) => (
          <PressableScale
            key={filter}
            accessibilityRole="button"
            accessibilityLabel={t(filter)}
            accessibilityState={{ selected: status === filter }}
            onPress={() => setStatus(filter)}
            style={[styles.chip, status === filter && styles.chipOn]}
          >
            <Text
              style={[styles.label, status === filter && styles.chipTextOn]}
            >
              {t(filter)}
            </Text>
          </PressableScale>
        ))}
      </View>
      {stock.isError || (!stock.data && stock.fetchStatus === 'paused') ? (
        <View
          testID={stock.isError ? 'stock-error' : 'stock-offline'}
          style={styles.message}
        >
          <Text accessibilityRole="alert">
            {t(stock.isError ? 'error' : 'offline')}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            onPress={() => void stock.refetch()}
            style={styles.chip}
          >
            <Text>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : null}
      {stock.data ? (
        <FlashList
          testID="stock-list"
          data={stock.data}
          keyExtractor={(item) => item.product_id}
          refreshing={refreshing}
          onRefresh={refresh}
          onEndReached={() => {
            if (stock.hasNextPage && !stock.isFetchingNextPage)
              void stock.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          ListEmptyComponent={<Text style={styles.message}>{t('empty')}</Text>}
          ListFooterComponent={
            stock.isFetchingNextPage ? (
              <ActivityIndicator accessibilityLabel={t('loading')} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={item.name ?? t('unnamed')}
              accessibilityHint={`${t('stock')} ${item.stock_quantity}, ${t(item.status)}`}
              onPress={() =>
                router.push({
                  pathname: '/product/[id]',
                  params: { id: item.product_id },
                })
              }
              style={[styles.row, index > 0 && styles.rowDivider]}
            >
              <PostHogMaskView style={styles.photo}>
                {item.image_url ? (
                  <Image
                    source={{ uri: item.image_url }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                    recyclingKey={item.product_id}
                    style={styles.image}
                    testID="stock-photo"
                  />
                ) : null}
              </PostHogMaskView>
              <View style={styles.detail}>
                <Text numberOfLines={1} style={styles.name}>
                  {item.name ?? t('unnamed')}
                </Text>
                <Text style={styles.caption}>
                  {fill(t('threshold'), { n: item.low_stock_threshold })}
                </Text>
              </View>
              <StockBadge quantity={item.stock_quantity} status={item.status} />
            </PressableScale>
          )}
        />
      ) : !stock.isError && stock.fetchStatus !== 'paused' ? (
        <ActivityIndicator accessibilityLabel={t('loading')} />
      ) : null}
      {lowItems.length > 0 ? (
        <View
          testID="stock-summary"
          style={[styles.summary, { marginBottom: insets.bottom }]}
        >
          <Icon icon={TriangleAlert} color={colors.warning} />
          <Text style={styles.summaryText}>
            {fill(t('summary'), { count: lowItems.length })}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('restock')}
            onPress={() =>
              router.push(
                assistantHref({
                  entry: 'chip',
                  prompt: t('restockPrompt'),
                  screen: 'stock',
                }),
              )
            }
            style={styles.restock}
          >
            <Text style={styles.restockText}>{t('restock')}</Text>
          </PressableScale>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: space[4],
    paddingBottom: space[4],
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
  },
  title: { ...typography.title, color: colors.ink, flex: 1 },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
    paddingHorizontal: space[4],
  },
  chip: {
    minHeight: 56,
    paddingHorizontal: space[4],
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  chipOn: { backgroundColor: colors.ink },
  chipTextOn: { color: colors.onInk },
  label: { ...typography.label, color: colors.ink },
  content: { paddingHorizontal: space[4] },
  row: {
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'center',
    paddingVertical: space[3],
  },
  /** Board: a hairline between rows. */
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.surfacePressed },
  photo: {
    height: 64,
    width: 64,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  detail: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  /** Board: warning card pinned under the list, radius 28, 12/16 padding. */
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    marginHorizontal: space[4],
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.warningSoft,
  },
  summaryText: { ...typography.label, flex: 1, color: colors.warning },
  restock: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 28,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  restockText: { ...typography.label, color: colors.ink },
  message: { padding: space[4], gap: space[3], color: colors.inkMuted },
});
