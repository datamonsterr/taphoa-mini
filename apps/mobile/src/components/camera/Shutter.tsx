import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { camera, colors, radius, size } from '@/theme';

type Props = {
  /** Board label: "Chụp" for the first capture, "Chụp lại" after. */
  label: string;
  busy?: boolean;
  onPress: () => void;
};

/** 88px gold-ring shutter; the white disc squeezes while pressed. */
export const Shutter = memo(function Shutter({ label, busy, onPress }: Props) {
  const scale = useSharedValue(1);
  const discStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.92, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      style={[styles.ring, busy && styles.busy]}
    >
      <Animated.View style={[styles.disc, discStyle]} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  ring: {
    width: size.shutter,
    height: size.shutter,
    padding: 6,
    borderWidth: 4,
    borderColor: colors.cameraRing,
    borderRadius: radius.full,
  },
  busy: { opacity: 0.6 },
  disc: {
    flex: 1,
    borderRadius: radius.full,
    backgroundColor: camera.white,
  },
});
