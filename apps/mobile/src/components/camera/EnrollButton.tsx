import { Tag } from 'lucide-react-native';
import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/Icon';
import { camera, colors, radius, size } from '@/theme';

type Props = {
  active?: boolean;
  /** Low match: amber fill with a looping halo. */
  pulse?: boolean;
  onPress: () => void;
  /** Member may not enroll: dimmed, inert, no pulse. */
  disabled?: boolean;
};

export const DISABLED_HINT =
  'Chỉ Chủ tiệm hoặc người được cấp quyền mới thêm hàng mới';

/** Toggles quick enrollment; purple when active, amber for a low checkout match. */
export const EnrollButton = memo(function EnrollButton({
  active = false,
  pulse: wantsPulse,
  onPress,
  disabled,
}: Props) {
  const pulse = wantsPulse && !disabled && !active;
  const phase = useSharedValue(0);
  useEffect(() => {
    if (pulse) {
      phase.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
    } else {
      cancelAnimation(phase);
      phase.value = 0;
    }
  }, [pulse, phase]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 1 - phase.value * 0.6,
    transform: [{ scale: 93 / size.tapLg - phase.value * 0.2 }],
  }));

  return (
    <View style={styles.wrap}>
      {pulse ? (
        <Animated.View
          testID="enroll-pulse"
          pointerEvents="none"
          style={[styles.halo, haloStyle]}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Thêm vào kho với giá"
        accessibilityState={{ selected: active, disabled: !!disabled }}
        aria-selected={active}
        accessibilityHint={disabled ? DISABLED_HINT : undefined}
        disabled={disabled}
        onPress={onPress}
        style={[
          styles.button,
          pulse && styles.pulse,
          active && styles.active,
          disabled && styles.disabled,
        ]}
      >
        <Icon icon={Tag} color={pulse ? colors.warning : camera.white} />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    width: size.tapLg,
    height: size.tapLg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.full,
    backgroundColor: camera.warningHalo,
  },
  button: {
    width: size.tapLg,
    height: size.tapLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: camera.glass,
  },
  active: { backgroundColor: colors.accent },
  pulse: { backgroundColor: colors.warningSoft },
  disabled: { opacity: 0.4 },
});
