import { Plus } from 'lucide-react-native';
import { memo, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { camera, colors, radius, size } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  disabled?: boolean;
  /** Selected boxes in the batch. Shows a badge when above 0. */
  count?: number;
  onPress: () => void;
};

/** `+` circle: disabled, active, or active with a batch count badge. */
export const AddButton = memo(function AddButton({
  disabled,
  count = 0,
  onPress,
}: Props) {
  const scale = useSharedValue(1);
  const previous = useRef(count);
  useEffect(() => {
    if (previous.current !== count) {
      previous.current = count;
      scale.value = withSequence(
        withTiming(1.3, { duration: 90 }),
        withSpring(1, { damping: 10, stiffness: 300 }),
      );
    }
  }, [count, scale]);
  const badgeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const label = count > 1 ? 'Thêm tất cả vào giỏ' : 'Thêm vào giỏ';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled ? styles.off : styles.on]}
    >
      <Icon icon={Plus} color={colors.onAccent} />
      {!disabled && count > 0 ? (
        <Animated.View testID="add-badge" style={[styles.badge, badgeStyle]}>
          <Text style={styles.badgeText}>{count}</Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  button: {
    width: size.tapLg,
    height: size.tapLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  off: { backgroundColor: camera.glass, opacity: 0.4 },
  on: {
    backgroundColor: colors.accent,
    boxShadow: `0 0 0 6px ${camera.accentHalo}`,
  },
  badge: {
    position: 'absolute',
    right: -6,
    top: -6,
    minWidth: 28,
    height: 28,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  badgeText: {
    fontFamily: fontFamily.extrabold,
    fontSize: 16,
    lineHeight: 28,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
});
