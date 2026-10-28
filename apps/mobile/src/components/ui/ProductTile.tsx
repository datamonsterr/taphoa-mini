import { PostHogMaskView } from '@/components/ui/ReplayMask';
import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { strings } from '@/features/stock/strings';
import type { Product } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { StockBadge } from './StockBadge';

import { formatVnd } from '@/lib/format';
import { colors, radius, space, typography } from '@/theme';

import { PressableScale } from './PressableScale';

export type ProductTileProps = {
  name: string;
  price: number;
  imageUri?: string;
  stockQuantity?: number | null;
  stockStatus?: Product['stock_status'];
  onPress?: () => void;
};

/** Tile for the 2-column inventory grid. */
export const ProductTile = memo(function ProductTile({
  name,
  price,
  imageUri,
  onPress,
  stockQuantity = null,
  stockStatus = 'untracked',
}: ProductTileProps) {
  const t = useT(strings);
  const priceText = formatVnd(price);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${priceText}`}
      accessibilityHint={
        stockQuantity !== null
          ? `${t('stock')} ${stockQuantity}, ${t(stockStatus)}`
          : undefined
      }
      pressedScale={0.98}
      onPress={onPress}
      style={styles.tile}
    >
      <PostHogMaskView style={styles.photo}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={imageUri}
            accessibilityIgnoresInvertColors
            style={styles.image}
            testID="product-photo"
          />
        ) : null}
        <View style={styles.badge}>
          <StockBadge quantity={stockQuantity} status={stockStatus} />
        </View>
      </PostHogMaskView>
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
      <Text numberOfLines={1} style={styles.price}>
        {priceText}
      </Text>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: space[2],
    right: space[2],
    maxWidth: '95%',
  },
  tile: { flex: 1, gap: space[2] },
  photo: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  image: { width: '70%', height: '70%' },
  name: { ...typography.label, color: colors.ink },
  price: {
    ...typography.heading,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
});
