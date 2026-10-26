import { PostHogMaskView } from 'posthog-react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, PressableScale, Text } from '@/components/ui';
import { StockBadge } from '@/components/ui/StockBadge';
import { useStock } from '@/lib/api/hooks';
import type { StockStatus } from '@/lib/api/stock';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { StockSegment } from './StockSegment';
import { strings } from './strings';

export function StockScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<StockStatus>('all');
  const [refreshing, setRefreshing] = useState(false);
  const stock = useStock(status);
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
        {(['all', 'low', 'out'] as const).map((filter) => (
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
      {stock.isError ? (
        <View style={styles.message}>
          <Text accessibilityRole="alert">{t('error')}</Text>
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
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + space[6] },
          ]}
          ListEmptyComponent={<Text style={styles.message}>{t('empty')}</Text>}
          ListFooterComponent={
            stock.isFetchingNextPage ? (
              <ActivityIndicator accessibilityLabel={t('loading')} />
            ) : null
          }
          renderItem={({ item }) => (
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
              style={styles.row}
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
                <Text style={styles.label}>{item.name ?? t('unnamed')}</Text>
                <StockBadge
                  quantity={item.stock_quantity}
                  status={item.status}
                />
              </View>
            </PressableScale>
          )}
        />
      ) : !stock.isError ? (
        <ActivityIndicator accessibilityLabel={t('loading')} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: space[4], backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
  },
  title: { ...typography.title, color: colors.ink },
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
  photo: {
    height: 72,
    width: 72,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  detail: { flex: 1, gap: space[2] },
  message: { padding: space[4], gap: space[3], color: colors.inkMuted },
});
