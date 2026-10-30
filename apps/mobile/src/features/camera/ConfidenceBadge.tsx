import { Check, CircleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import type { Rect } from '@/lib/bbox';
import { colors, radius } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props = {
  box: Rect;
  /** Whole percent; null when the server had no candidate at all. */
  percent: number | null;
  /** Unknown or ambiguous: amber alert instead of the green check. */
  low: boolean;
};

const HEIGHT = 24;
const GAP = 6;
/** Viewfinder corner mark (inset 14 + arm 22) plus a gap: a badge near the top starts right of it. */
const CORNER_CLEAR = 44;

/** Single-item board: green check and score above the box, amber alert when low. */
export const ConfidenceBadge = memo(function ConfidenceBadge({
  box,
  percent,
  low,
}: Props) {
  const tint = low ? colors.warning : colors.success;
  const top = Math.max(GAP, box.y - HEIGHT - GAP);
  return (
    <View
      testID="confidence-badge"
      accessibilityLabel={
        percent === null ? 'Chưa nhận ra món này' : `Độ chắc chắn ${percent}%`
      }
      style={[
        styles.badge,
        {
          left: Math.max(box.x, top < CORNER_CLEAR ? CORNER_CLEAR : GAP),
          top,
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
      {percent === null ? null : (
        <Text style={[styles.text, { color: tint }]}>{percent}</Text>
      )}
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
