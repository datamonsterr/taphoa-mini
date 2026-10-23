import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { colors, fontFamily, radius } from '@/theme';

import { PressableScale } from './PressableScale';

export type Period = 'day' | 'week' | 'month';

export const PERIODS: readonly { id: Period; label: string }[] = [
  { id: 'day', label: 'Ngày' },
  { id: 'week', label: 'Tuần' },
  { id: 'month', label: 'Tháng' },
];

export type PeriodChipsLabels = { group: string } & Record<Period, string>;

const DEFAULT_LABELS: PeriodChipsLabels = {
  group: 'Khoảng thời gian',
  day: 'Ngày',
  week: 'Tuần',
  month: 'Tháng',
};

export type PeriodChipsProps = {
  value: Period;
  onChange: (period: Period) => void;
  /** Visible words and group label; Vietnamese board wording by default. */
  labels?: PeriodChipsLabels;
};

export const PeriodChips = memo(function PeriodChips({
  value,
  onChange,
  labels = DEFAULT_LABELS,
}: PeriodChipsProps) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={labels.group}
      style={styles.row}
    >
      {PERIODS.map(({ id }) => {
        const on = id === value;
        const label = labels[id];
        return (
          <PressableScale
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: on, selected: on }}
            aria-checked={on}
            aria-selected={on}
            hitSlop={{ top: 4, bottom: 4 }}
            pressedScale={0.96}
            onPress={() => onChange(id)}
            style={[styles.chip, on && styles.chipOn]}
          >
            <Text style={[styles.text, on && styles.textOn]}>{label}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    minHeight: 48,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  chipOn: { backgroundColor: colors.ink },
  text: {
    fontFamily: fontFamily.semibold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.ink,
  },
  textOn: { color: colors.onInk },
});
