import { Check } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { useSettingsStore } from '@/stores/settings';
import { colors, radius, size } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type CheckButtonVariant = 'success' | 'ink';

export type CheckButtonProps = {
  /** success = received, ink = save. */
  variant: CheckButtonVariant;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  /** Full-width (save buttons in sheets). */
  block?: boolean;
  /** 80px pay button with a 32px check (board 07). */
  xl?: boolean;
};

export const CheckButton = memo(function CheckButton({
  variant,
  accessibilityLabel,
  onPress,
  disabled = false,
  block = false,
  xl = false,
}: CheckButtonProps) {
  const elder = useSettingsStore((s) => s.elderMode);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      pressedScale={0.96}
      onPress={onPress}
      style={[
        styles.base,
        variant === 'success' ? styles.success : styles.ink,
        block && styles.block,
        (xl || elder) && styles.xl,
        disabled && styles.disabled,
      ]}
    >
      <Icon icon={Check} size={xl ? 32 : undefined} color={colors.onInk} />
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: size.tapLg,
    paddingHorizontal: 40,
    borderRadius: radius.full,
  },
  success: { backgroundColor: colors.success },
  ink: { backgroundColor: colors.ink },
  block: { alignSelf: 'stretch' },
  xl: { minHeight: size.tapXl },
  disabled: { opacity: 0.4 },
});
