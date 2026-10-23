import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatVnd } from '@/lib/format';
import { camera, colors, radius } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  name: string;
  price: number;
  thumbnailUri?: string;
  /** Current top-1 match: white chip with an accent ring. */
  current?: boolean;
  onPress: () => void;
};

/** One product choice in the alternatives strip. */
export const StripChip = memo(function StripChip({
  name,
  price,
  thumbnailUri,
  current,
  onPress,
}: Props) {
  const money = formatVnd(price);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${name} ${money}`}
      accessibilityState={{ checked: !!current }}
      aria-checked={!!current}
      onPress={onPress}
      style={[styles.chip, current ? styles.current : styles.alternative]}
    >
      {thumbnailUri ? (
        <Image
          testID="chip-thumb"
          source={{ uri: thumbnailUri }}
          contentFit="cover"
          style={styles.thumb}
        />
      ) : (
        <View testID="chip-placeholder" style={styles.thumb} />
      )}
      <Text
        style={[styles.price, { color: current ? colors.ink : camera.white }]}
      >
        {money.replace('đ', '')}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  chip: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 16,
    borderRadius: radius.full,
  },
  current: {
    backgroundColor: camera.white,
    borderWidth: 3,
    borderColor: colors.accent,
  },
  alternative: { backgroundColor: camera.chipDark },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  price: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
});
