import type { LucideIcon } from 'lucide-react-native';
import { TriangleAlert } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { Text } from './ScaledText';

import { colors, fontFamily, radius, size } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type AlertPillProps = {
  count: number;
  /** Spoken label after the count, e.g. "món sắp hết". */
  label: string;
  icon?: LucideIcon;
  /** warning = amber (default), neutral = soft grey. */
  tone?: 'warning' | 'neutral';
  onPress?: () => void;
};

export const AlertPill = memo(function AlertPill({
  count,
  label,
  icon = TriangleAlert,
  tone = 'warning',
  onPress,
}: AlertPillProps) {
  const warning = tone === 'warning';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${count} ${label}`}
      pressedScale={0.96}
      onPress={onPress}
      style={[styles.pill, warning ? styles.warning : styles.neutral]}
    >
      <Icon icon={icon} color={warning ? colors.warning : colors.ink} />
      <Text
        style={[styles.count, { color: warning ? colors.warning : colors.ink }]}
      >
        {count}
      </Text>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: size.tapLg,
    paddingHorizontal: 18,
    borderRadius: radius.full,
  },
  warning: { backgroundColor: colors.warningSoft },
  neutral: { backgroundColor: colors.surfaceSoft },
  count: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    lineHeight: 28,
    fontVariant: ['tabular-nums'],
  },
});
