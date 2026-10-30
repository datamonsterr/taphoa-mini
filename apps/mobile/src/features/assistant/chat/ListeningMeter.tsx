import { memo, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/ScaledText';
import { colors, radius, size, space, typography } from '@/theme';

/** Board 17b: bar heights in dp; the two end bars are the soft accent. */
const BARS = [10, 20, 30, 18, 26, 14, 22, 8] as const;

const Bar = memo(function Bar({
  index,
  wave,
}: {
  index: number;
  wave: SharedValue<number>;
}) {
  const base = BARS[index] as number;
  const other = BARS[(index + 3) % BARS.length] as number;
  const style = useAnimatedStyle(() => ({
    height: base + (other - base) * wave.value,
  }));
  const edge = index === 0 || index === BARS.length - 1;
  return (
    <Animated.View
      style={[
        styles.bar,
        { height: base },
        { backgroundColor: edge ? colors.accentSoft : colors.accent },
        style,
      ]}
    />
  );
});

/** `m:ss` of the seconds since the hold began. */
export const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The input's look while the microphone is held: level bars and the elapsed time. It mounts on
 * press and unmounts on release, so the timer starts at 0:00 every hold.
 */
export const ListeningMeter = memo(function ListeningMeter({
  label,
}: {
  label: string;
}) {
  const [seconds, setSeconds] = useState(0);
  const wave = useSharedValue(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    wave.value = withRepeat(withTiming(1, { duration: 450 }), -1, true);
    return () => {
      clearInterval(timer);
      cancelAnimation(wave);
    };
  }, [wave]);
  return (
    <View
      testID="assistant-listening"
      accessibilityLabel={label}
      style={styles.field}
    >
      {BARS.map((_, index) => (
        <Bar key={index} index={index} wave={wave} />
      ))}
      <Text testID="assistant-listening-time" style={styles.time}>
        {formatElapsed(seconds)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    flex: 1,
    height: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space[4] + space[1],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  bar: { width: 5, borderRadius: 3 },
  time: {
    ...typography.caption,
    marginLeft: space[3] - 2,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
});
