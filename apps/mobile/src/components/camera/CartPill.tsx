import { ShoppingCart } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { formatVnd } from '@/lib/format';
import { camera, colors, radius, size, space } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  count: number;
  /** Running total in đồng. */
  total: number;
  onPress: () => void;
  /** Dark pill for light screens (the sell grid); the default is the glass pill over the camera. */
  light?: boolean;
};

/** Bottom-left cart shortcut: count badge and running total. */
export const CartPill = memo(function CartPill({
  count,
  total,
  onPress,
  light = false,
}: Props) {
  const money = formatVnd(total);
  const empty = count === 0;
  const label =
    count === 0 ? 'Giỏ hàng trống' : `Giỏ hàng: ${count} món, ${money}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.pill, light && styles.pillLight]}
    >
      {empty ? (
        <>
          <Icon icon={ShoppingCart} color={colors.cameraMuted} />
          <Text testID="cart-empty" style={styles.zero}>
            0
          </Text>
        </>
      ) : (
        <>
          <View style={styles.cart}>
            <Icon icon={ShoppingCart} color={camera.white} />
            <View style={styles.badge}>
              <Text testID="cart-count" style={styles.badgeText}>
                {count}
              </Text>
            </View>
          </View>
          <Text style={styles.total}>{money}</Text>
        </>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pillLight: { backgroundColor: colors.ink },
  pill: {
    height: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingLeft: space[3],
    paddingRight: space[4],
    borderRadius: radius.full,
    backgroundColor: camera.glass,
  },
  cart: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    right: -6,
    top: -6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  badgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    lineHeight: 20,
    color: colors.onAccent,
    fontVariant: ['tabular-nums'],
  },
  zero: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    color: colors.cameraMuted,
    fontVariant: ['tabular-nums'],
  },
  total: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    color: camera.white,
    fontVariant: ['tabular-nums'],
  },
});
