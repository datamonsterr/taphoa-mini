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
  /** Low match: amber fill with a looping halo. */
  pulse?: boolean;
  onPress: () => void;
};

/** Tag circle that opens enroll. */
export const EnrollButton = memo(function EnrollButton({
  pulse,
  onPress,
}: Props) {
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
        onPress={onPress}
        style={[styles.button, pulse && styles.pulse]}
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
  pulse: { backgroundColor: colors.warningSoft },
});
