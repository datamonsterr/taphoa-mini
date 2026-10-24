import { Check, CircleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import type { Rect } from '@/lib/bbox';
import { colors, radius } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  box: Rect;
  /** Whole percent. */
  percent: number;
  low: boolean;
};

const HEIGHT = 24;
const GAP = 6;

/** Single-item board: green check and score above the box, amber alert when low. */
export const ConfidenceBadge = memo(function ConfidenceBadge({
  box,
  percent,
  low,
}: Props) {
  const tint = low ? colors.warning : colors.success;
  return (
    <View
      testID="confidence-badge"
      accessibilityLabel={`Độ chắc chắn ${percent}%`}
      style={[
        styles.badge,
        {
          left: box.x,
          top: Math.max(GAP, box.y - HEIGHT - GAP),
          backgroundColor: low ? colors.warningSoft : colors.successSoft,
        },
      ]}
    >
      <Icon
        icon={low ? CircleAlert : Check}
        size={14}
        strokeWidth={3}
        color={tint}
      />
      <Text style={[styles.text, { color: tint }]}>{percent}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    height: HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    borderRadius: radius.full,
  },
  text: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
});
