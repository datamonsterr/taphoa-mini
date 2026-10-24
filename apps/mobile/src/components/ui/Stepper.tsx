import { Minus, Plus, Trash2 } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from './ScaledText';

import { colors, radius, typography } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

/** Below this window width the stepper uses smaller buttons so it leaves room for the line text. */
const COMPACT_WIDTH = 360;

export type StepperLabels = {
  remove: string;
  decrement: string;
  increment: string;
  /** Spoken quantity, e.g. `Số lượng 3`. */
  quantity: (value: number) => string;
};

const DEFAULT_LABELS: StepperLabels = {
  remove: 'Xóa',
  decrement: 'Bớt một',
  increment: 'Thêm một',
  quantity: (value) => `Số lượng ${value}`,
};

export type StepperProps = {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Called instead of onDecrement when value is 1 (the minus is a trash). */
  onRemove: () => void;
  /** Accessible names; Vietnamese by default. */
  labels?: StepperLabels;
};

export const Stepper = memo(function Stepper({
  value,
  onIncrement,
  onDecrement,
  onRemove,
  labels = DEFAULT_LABELS,
}: StepperProps) {
  const isOne = value <= 1;
  const compact = useWindowDimensions().width < COMPACT_WIDTH;
  return (
    <View style={styles.wrap}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={isOne ? labels.remove : labels.decrement}
        hitSlop={2}
        onPress={isOne ? onRemove : onDecrement}
        style={[styles.button, compact && styles.buttonCompact]}
      >
        <Icon
          icon={isOne ? Trash2 : Minus}
          color={isOne ? colors.danger : colors.ink}
        />
      </PressableScale>
      <Text
        accessibilityRole="text"
        accessibilityLabel={labels.quantity(value)}
        accessibilityLiveRegion="polite"
        style={[styles.value, compact && styles.valueCompact]}
      >
        {value}
      </Text>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={labels.increment}
        hitSlop={2}
        onPress={onIncrement}
        style={[styles.button, compact && styles.buttonCompact]}
      >
        <Icon icon={Plus} />
      </PressableScale>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexShrink: 0,
    gap: 4,
    padding: 4,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  button: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  buttonCompact: { width: 44, height: 44 },
  valueCompact: { minWidth: 28 },
  value: {
    ...typography.heading,
    minWidth: 40,
    textAlign: 'center',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
});
