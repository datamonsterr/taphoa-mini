import { Plus } from 'lucide-react-native';
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
import { colors, radius, size, space, typography } from '@/theme';

import { useSettingsStore } from '@/stores/settings';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type ProductTileProps = {
  name: string;
  price: number;
  imageUri?: string;
  stockQuantity?: number | null;
  stockStatus?: Product['stock_status'];
  onPress?: () => void;
  /** When set, a `+` on the photo adds the product to the cart (S3 grid sale). */
  onAdd?: () => void;
  addLabel?: string;
};

/** Tile for the 2-column inventory grid. */
export const ProductTile = memo(function ProductTile({
  name,
  price,
  imageUri,
  onPress,
  onAdd,
  addLabel,
  stockQuantity = null,
  stockStatus = 'untracked',
}: ProductTileProps) {
  const t = useT(strings);
  const priceText = formatVnd(price);
  const elder = useSettingsStore((s) => s.elderMode);
  return (
    <View style={styles.root}>
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
        <Text
          numberOfLines={1}
          style={[styles.name, elder && styles.nameElder]}
        >
          {name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.price, elder && styles.priceElder]}
        >
          {priceText}
        </Text>
      </PressableScale>
      {onAdd ? (
        <View pointerEvents="box-none" style={styles.addLayer}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={addLabel ?? `Thêm ${name} vào giỏ`}
            onPress={onAdd}
            style={[styles.add, elder && styles.addElder]}
          >
            <Icon icon={Plus} size={elder ? 36 : 28} color={colors.onAccent} />
          </PressableScale>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: space[2],
    right: space[2],
    maxWidth: '95%',
  },
  root: { flex: 1 },
  tile: { flex: 1, gap: space[2] },
  /** Square layer over the photo (same width, 1:1) that anchors the `+` to its corner. */
  addLayer: {
    ...StyleSheet.absoluteFill,
    aspectRatio: 1,
    bottom: undefined,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    padding: space[2],
  },
  add: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  addElder: { width: size.tapXl, height: size.tapXl },
  nameElder: { fontSize: 22, lineHeight: 28 },
  priceElder: { fontSize: 30, lineHeight: 36 },
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
