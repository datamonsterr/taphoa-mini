import { FlashList } from '@shopify/flash-list';
import { Search, X } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { Text } from '@/components/ui';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton } from '@/components/ui/CircleButton';
import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { shouldDismiss } from '@/components/ui/Sheet';
import { ProductTile } from '@/components/ui/ProductTile';
import { useLowStockProducts, useProducts } from '@/lib/api/hooks';
import { isLowStock } from '@/lib/api/stock';
import type { ProductWithStock } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { strings } from './strings';
import { useDebouncedValue } from './useDebouncedValue';

export const HANDLE_PAN_TEST_ID = 'inventory-handle-pan';
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;
const COLUMNS = 2;
const SKELETON_TILES = 6;
/** Half of the board's 12px grid gap, applied on each tile. */
const HALF_GAP = space[3] / 2;

/** Case- and accent-insensitive key for the client-side low-stock search. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();

const keyExtractor = (product: ProductWithStock) => product.id;

const InventoryTile = memo(function InventoryTile({
  product,
}: {
  product: ProductWithStock;
}) {
  const { id } = product;
  const onPress = useCallback(
    () => router.push({ pathname: '/product/[id]', params: { id } }),
    [id],
  );
  return (
    <View style={styles.cell}>
      <ProductTile
        name={product.name ?? ''}
        price={product.price}
        stock={product.stock_quantity}
        low={isLowStock(product)}
        imageUri={product.images[0]?.url}
        onPress={onPress}
      />
    </View>
  );
});

const renderItem = ({ item }: { item: ProductWithStock }) => (
  <InventoryTile product={item} />
);

function Handle() {
  const t = useT(strings);
  const goCamera = useCallback(() => router.dismissTo('/'), []);
  const pan = usePanGesture({
    testID: HANDLE_PAN_TEST_ID,
    runOnJS: true,
    activeOffsetY: 8,
    onDeactivate: (event) => {
      if (shouldDismiss(event.translationY, event.velocityY)) goCamera();
    },
  });
  return (
    <GestureDetector gesture={pan}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('handle')}
        pressedScale={0.98}
        onPress={goCamera}
        style={styles.handleRow}
      >
        <View style={styles.handle} />
      </PressableScale>
    </GestureDetector>
  );
}

type SearchFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  onClose: () => void;
};

/** Text field the search circle expands into. */
function SearchField({ value, onChangeText, onClose }: SearchFieldProps) {
  const t = useT(strings);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: 200 });
  }, [progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * 24 }],
  }));
  return (
    <Animated.View style={[styles.searchRow, animated]}>
      <View style={styles.field}>
        <Icon icon={Search} color={colors.inkMuted} />
        <TextInput
          autoFocus
          value={value}
          onChangeText={onChangeText}
          accessibilityLabel={t('searchField')}
          placeholder={t('searchField')}
          placeholderTextColor={colors.inkMuted}
          returnKeyType="search"
          autoCorrect={false}
          style={styles.input}
        />
      </View>
      <CircleButton
        icon={X}
        accessibilityLabel={t('closeSearch')}
        onPress={onClose}
      />
    </Animated.View>
  );
}

function SkeletonGrid() {
  return (
    <View style={styles.skeletonGrid} testID="inventory-skeleton">
      {Array.from({ length: SKELETON_TILES }, (_, i) => (
        <View key={i} style={styles.cell}>
          <View style={styles.skeletonPhoto} />
          <View style={styles.skeletonName} />
          <View style={styles.skeletonPrice} />
        </View>
      ))}
    </View>
  );
}

function Message({
  text,
  actionLabel,
  onAction,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
      {actionLabel ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={styles.retry}
        >
          <Text style={styles.retryText}>{actionLabel}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

export function InventoryScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const q = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  // `?filter=low` comes from the dashboard's low-stock pill.
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const lowOnly = filter === 'low';

  const all = useProducts({ q: q || undefined, limit: PAGE_SIZE });
  const low = useLowStockProducts(undefined, lowOnly);
  const active = lowOnly ? low : all;
  const { isError, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } =
    active;
  const data = useMemo(() => {
    if (!active.data) return undefined;
    if (!lowOnly || !q) return active.data;
    const needle = fold(q);
    return active.data.filter((p) => fold(p.name ?? '').includes(needle));
  }, [active.data, lowOnly, q]);
  const clearFilter = useCallback(
    () => router.setParams({ filter: undefined }),
    [],
  );

  const openSearch = useCallback(() => setSearching(true), []);
  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery('');
  }, []);
  const retry = useCallback(() => void refetch(), [refetch]);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  let body;
  if (data) {
    body = (
      <FlashList
        testID="inventory-list"
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={COLUMNS}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Message text={t(q ? 'emptySearch' : 'empty')} />}
        ListFooterComponent={
          isFetchingNextPage ? <ActivityIndicator color={colors.ink} /> : null
        }
      />
    );
  } else if (isError) {
    body = (
      <Message text={t('error')} actionLabel={t('retry')} onAction={retry} />
    );
  } else {
    body = <SkeletonGrid />;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[2] }]}>
      <Handle />
      <View style={styles.header}>
        {searching ? (
          <SearchField
            value={query}
            onChangeText={setQuery}
            onClose={closeSearch}
          />
        ) : (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {t('title')}
            </Text>
            <CircleButton
              icon={Search}
              accessibilityLabel={t('search')}
              onPress={openSearch}
            />
          </>
        )}
      </View>
      {lowOnly ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('clearLowFilter')}
          pressedScale={0.96}
          onPress={clearFilter}
          style={styles.filterChip}
        >
          <Text style={styles.filterText}>{t('lowFilter')}</Text>
          <Icon icon={X} size={18} color={colors.warning} />
        </PressableScale>
      ) : null}
      <View style={styles.body}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.surface,
    gap: space[4],
  },
  handleRow: { alignItems: 'center', paddingVertical: 6 },
  handle: {
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.surfacePressed,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
  },
  title: { ...typography.title, color: colors.ink },
  searchRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    height: 56,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  input: { flex: 1, ...typography.body, color: colors.ink, padding: 0 },
  filterChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 48,
    marginLeft: space[4],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.warningSoft,
  },
  filterText: { ...typography.label, color: colors.warning },
  body: { flex: 1 },
  /** Board: 16px side padding, 112px at the bottom for the bar. */
  listContent: {
    paddingHorizontal: space[4] - HALF_GAP,
    paddingBottom: 112,
  },
  cell: { flex: 1, paddingHorizontal: HALF_GAP, paddingBottom: space[3] },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: space[4] - HALF_GAP,
  },
  skeletonPhoto: {
    aspectRatio: 1,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  skeletonName: {
    width: '70%',
    height: 18,
    marginTop: space[2],
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  skeletonPrice: {
    width: '45%',
    height: 22,
    marginTop: space[2],
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  message: {
    alignItems: 'center',
    gap: space[4],
    paddingTop: space[8],
    paddingHorizontal: space[4],
  },
  messageText: {
    ...typography.body,
    color: colors.inkMuted,
    textAlign: 'center',
  },
  retry: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space[6],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  retryText: { ...typography.label, color: colors.onInk },
});
