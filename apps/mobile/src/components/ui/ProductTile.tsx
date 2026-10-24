import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { formatVnd } from '@/lib/format';
import { colors, radius, space, typography } from '@/theme';

import { PressableScale } from './PressableScale';

export type ProductTileProps = {
  name: string;
  price: number;
  imageUri?: string;
  onPress?: () => void;
};

/** Tile for the 2-column inventory grid. */
export const ProductTile = memo(function ProductTile({
  name,
  price,
  imageUri,
  onPress,
}: ProductTileProps) {
  const priceText = formatVnd(price);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${priceText}`}
      pressedScale={0.98}
      onPress={onPress}
      style={styles.tile}
    >
      <View style={styles.photo}>
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
      </View>
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
