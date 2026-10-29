import { FlashList } from '@shopify/flash-list';
import { Search, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { Text } from '@/components/ui';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CartPill } from '@/components/camera/CartPill';
import { CircleButton } from '@/components/ui/CircleButton';
import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { shouldDismiss } from '@/components/ui/Sheet';
import { ProductTile } from '@/components/ui/ProductTile';
import { useProducts } from '@/lib/api/hooks';
import type { Product } from '@/lib/api/types';
import { fill, useT } from '@/lib/i18n';
import { selectCount, selectTotal, useCartStore } from '@/stores/cart';
import { colors, radius, size, space, typography } from '@/theme';

import { StockSegment } from '@/features/stock/StockSegment';

import { strings } from './strings';
import { useDebouncedValue } from './useDebouncedValue';

export const HANDLE_PAN_TEST_ID = 'inventory-handle-pan';
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;
const COLUMNS = 2;
const SKELETON_TILES = 6;
/** Half of the board's 12px grid gap, applied on each tile. */
const HALF_GAP = space[3] / 2;

/** Above the 64 dp floating bar (16 dp inset). */
const PILL_BOTTOM = space[4] + size.tapLg + space[3];

const keyExtractor = (product: Product) => product.id;

const InventoryTile = memo(function InventoryTile({
  product,
}: {
  product: Product;
}) {
  const { id } = product;
  const onPress = useCallback(
    () => router.push({ pathname: '/product/[id]', params: { id } }),
    [id],
  );
  const t = useT(strings);
  const addToCart = useCartStore((s) => s.add);
  const name = product.name ?? '';
  const imageUrl = product.images[0]?.url;
  const onAdd = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    addToCart({
      productId: id,
      name,
      price: product.price,
      imageUrl,
      source: 'grid',
    });
  }, [addToCart, id, name, product.price, imageUrl]);
  return (
    <View style={styles.cell}>
      <ProductTile
        onAdd={onAdd}
        addLabel={fill(t('add'), { name })}
        name={product.name ?? ''}
        price={product.price}
        stockQuantity={product.stock_quantity}
        stockStatus={product.stock_status}
        imageUri={product.images[0]?.url}
        onPress={onPress}
      />
    </View>
  );
});

const renderItem = ({ item }: { item: Product }) => (
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

const openCart = () => router.push('/cart');

/** Sell-grid cart shortcut (S3): shows once something is in the cart and opens it. */
const GridCartPill = memo(function GridCartPill() {
  const count = useCartStore(selectCount);
  const total = useCartStore(selectTotal);
  const insets = useSafeAreaInsets();
  if (count === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.pillWrap, { bottom: insets.bottom + PILL_BOTTOM }]}
    >
      <CartPill light count={count} total={total} onPress={openCart} />
    </View>
  );
});

export function InventoryScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const q = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  const {
    data,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useProducts({ q: q || undefined, limit: PAGE_SIZE });

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
      <StockSegment selected="products" />
      <View style={styles.body}>{body}</View>
      <GridCartPill />
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
  body: { flex: 1 },
  pillWrap: { position: 'absolute', left: space[4] },
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
