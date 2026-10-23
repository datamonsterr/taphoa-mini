import { memo, useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius } from '@/theme';

export type SwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

const KNOB_OFF = 4;
const KNOB_ON = 32;

export const Switch = memo(function Switch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
}: SwitchProps) {
  const x = useSharedValue(value ? KNOB_ON : KNOB_OFF);
  useEffect(() => {
    x.value = withTiming(value ? KNOB_ON : KNOB_OFF, { duration: 120 });
  }, [value, x]);
  const knobStyle = useAnimatedStyle(() => ({ left: x.value }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      disabled={disabled}
      hitSlop={6}
      onPress={() => onValueChange(!value)}
      style={[
        styles.track,
        value ? styles.on : styles.off,
        disabled && styles.disabled,
      ]}
    >
      <Animated.View style={[styles.knob, knobStyle]} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  track: { width: 72, height: 44, borderRadius: radius.full },
  on: { backgroundColor: colors.accent },
  off: { backgroundColor: colors.lineStrong },
  knob: {
    position: 'absolute',
    top: 4,
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  disabled: { opacity: 0.4 },
});
