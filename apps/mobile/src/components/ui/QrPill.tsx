import { QrCode } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { Text } from './ScaledText';

import { useSettingsStore } from '@/stores/settings';
import { colors, radius, size, space, typography } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type QrPillProps = {
  onPress: () => void;
  /** Optional visible text, e.g. the total. Board shows the icon only. */
  label?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
};

export const QrPill = memo(function QrPill({
  onPress,
  label,
  accessibilityLabel = 'Hiện mã QR thanh toán',
  disabled = false,
}: QrPillProps) {
  const elder = useSettingsStore((s) => s.elderMode);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      pressedScale={0.96}
      onPress={onPress}
      style={[styles.pill, elder && styles.elder, disabled && styles.disabled]}
    >
      <Icon icon={QrCode} color={colors.onInk} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: size.tapLg,
    paddingHorizontal: 22,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  label: { ...typography.label, color: colors.onInk },
  elder: { minHeight: size.tapXl },
  disabled: { opacity: 0.4 },
});
