import { Check, TriangleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './ScaledText';

import { formatVnd } from '@/lib/format';
import { colors, fontFamily, radius } from '@/theme';

import { Icon } from './Icon';

export type DifferenceStatus = 'match' | 'short' | 'extra';

export function differenceStatus(difference: number): DifferenceStatus {
  if (difference === 0) return 'match';
  return difference < 0 ? 'short' : 'extra';
}

export type DifferenceLabels = Record<DifferenceStatus, string>;

const DEFAULT_LABELS: DifferenceLabels = {
  match: 'Khớp',
  short: 'Thiếu',
  extra: 'Dư',
};

export type DifferencePillProps = {
  /** counted - expected, in đồng. */
  difference: number;
  /** Words read by screen readers; Vietnamese board wording by default. */
  labels?: DifferenceLabels;
};

const tone = {
  match: { bg: colors.successSoft, fg: colors.success },
  short: { bg: colors.dangerSoft, fg: colors.danger },
  extra: { bg: colors.warningSoft, fg: colors.warning },
} as const;

/** Close-of-day difference: icon + signed amount (the word is read aloud), so colour is never alone. */
export const DifferencePill = memo(function DifferencePill({
  difference,
  labels = DEFAULT_LABELS,
}: DifferencePillProps) {
  const status = differenceStatus(difference);
  const { bg, fg } = tone[status];
  const word = labels[status];
  const amount = formatVnd(Math.abs(difference));
  // The board shows the signed amount ("−10.000đ"); the words live in the accessibility label.
  const signed =
    status === 'match' ? amount : `${status === 'short' ? '−' : '+'}${amount}`;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={status === 'match' ? word : `${word} ${amount}`}
      style={[styles.pill, { backgroundColor: bg }]}
    >
      <Icon
        icon={status === 'match' ? Check : TriangleAlert}
        size={22}
        color={fg}
      />
      <Text style={[styles.text, { color: fg }]}>{signed}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 6,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: radius.full,
  },
  text: {
    fontFamily: fontFamily.extrabold,
    fontSize: 22,
    lineHeight: 28,
    fontVariant: ['tabular-nums'],
  },
});
