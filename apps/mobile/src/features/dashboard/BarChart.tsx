import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius, space, typography } from '@/theme';

import { CHART_HEIGHT, type Bar } from './bars';

const GROW_MS = 450;

type GrowingBarProps = { height: number; expense?: boolean; testID: string };

/** A bar that grows from 0 on mount and whenever its target height changes (UI thread). */
const GrowingBar = memo(function GrowingBar({
  height,
  expense,
  testID,
}: GrowingBarProps) {
  const animated = useSharedValue(0);
  useEffect(() => {
    animated.value = withTiming(height, { duration: GROW_MS });
  }, [animated, height]);
  const style = useAnimatedStyle(() => ({ height: animated.value }));
  return (
    <Animated.View
      testID={testID}
      style={[styles.bar, expense ? styles.expense : styles.revenue, style]}
    />
  );
});

type Props = { bars: readonly Bar[]; label: string };

/** Revenue (ink) and expense (red) bars per bucket, with weekday / date labels below. */
export const BarChart = memo(function BarChart({ bars, label }: Props) {
  return (
    <View style={styles.card}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        style={styles.columns}
      >
        {bars.map((bar, index) => (
          <View key={bar.key} style={styles.column}>
            <GrowingBar
              testID={`bar-revenue-${index}`}
              height={bar.revenueHeight}
            />
            <GrowingBar
              testID={`bar-expense-${index}`}
              height={bar.expenseHeight}
              expense
            />
          </View>
        ))}
      </View>
      <View style={styles.labels}>
        {bars.map((bar) => (
          <Text
            key={bar.key}
            style={[
              styles.day,
              { color: bar.current ? colors.ink : colors.inkMuted },
            ]}
          >
            {bar.label}
          </Text>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  columns: { flexDirection: 'row', gap: space[2], height: CHART_HEIGHT },
  column: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 3,
    height: CHART_HEIGHT,
  },
  bar: {
    width: 14,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },
  revenue: { backgroundColor: colors.ink },
  expense: { backgroundColor: colors.danger, opacity: 0.55 },
  // Board: caption sits in a 26px line box.
  labels: {
    flexDirection: 'row',
    gap: space[2],
    marginTop: space[2],
    minHeight: 26,
  },
  day: { ...typography.caption, flex: 1, textAlign: 'center' },
});
