import type { LucideIcon } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { colors, radius, shadows, size } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

/** `surface` is the white button for use on a soft row. */
export type CircleButtonVariant = 'soft' | 'ink' | 'accent' | 'surface';

export type CircleButtonProps = {
  icon: LucideIcon;
  /** Vietnamese label from the board. Required: the control has no text. */
  accessibilityLabel: string;
  onPress?: () => void;
  /** A long press (also offered to screen readers as the `longpress` action, labelled by the hint). */
  onLongPress?: () => void;
  accessibilityHint?: string;
  variant?: CircleButtonVariant;
  /** 56 (tap-min) or 64 (tap-lg). */
  large?: boolean;
  /** Adds the floating shadow. */
  floating?: boolean;
  disabled?: boolean;
  iconColor?: string;
  testID?: string;
};

const iconOn: Record<CircleButtonVariant, string> = {
  soft: colors.ink,
  surface: colors.ink,
  ink: colors.onInk,
  accent: colors.onAccent,
};

export const CircleButton = memo(function CircleButton({
  icon,
  accessibilityLabel,
  onPress,
  onLongPress,
  accessibilityHint,
  variant = 'soft',
  large = false,
  floating = false,
  disabled = false,
  iconColor,
  testID,
}: CircleButtonProps) {
  const dimension = large ? size.tapLg : size.tapMin;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      accessibilityHint={accessibilityHint}
      accessibilityActions={
        onLongPress
          ? [{ name: 'longpress', label: accessibilityHint }]
          : undefined
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onLongPress?.();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      style={[
        styles.base,
        { width: dimension, height: dimension },
        styles[variant],
        floating && shadows.float,
        disabled && styles.disabled,
      ]}
    >
      <Icon icon={icon} color={iconColor ?? iconOn[variant]} />
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  soft: { backgroundColor: colors.surfaceSoft },
  surface: { backgroundColor: colors.surface },
  ink: { backgroundColor: colors.ink },
  accent: { backgroundColor: colors.accent },
  disabled: { opacity: 0.4 },
});
