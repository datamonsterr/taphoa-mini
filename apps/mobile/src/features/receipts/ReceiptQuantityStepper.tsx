import { Minus, Plus, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { Icon, PressableScale, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';
import { strings } from './strings';

/** Receipt quantities never delete a line: the separate trash button does that. */
export function ReceiptQuantityStepper({
  name,
  value,
  onChange,
  disabled = false,
}: {
  name: string;
  value: number;
  onChange: (quantity: number) => void;
  disabled?: boolean;
}) {
  const t = useT(strings);
  return (
    <View style={styles.stepper}>
      <StepButton
        icon={Minus}
        label={`${t('decrement')}: ${name}`}
        disabled={disabled || value <= 1}
        onPress={() => onChange(Math.max(1, value - 1))}
      />
      <Text
        accessibilityLabel={`${t('quantity')}: ${name}`}
        accessibilityLiveRegion="polite"
        style={styles.value}
      >
        {value}
      </Text>
      <StepButton
        icon={Plus}
        label={`${t('increment')}: ${name}`}
        disabled={disabled || value >= 2147483647}
        onPress={() => onChange(value + 1)}
      />
    </View>
  );
}

/** Board 19b draws 40px buttons so the stepper, price and total fit one row. The hit slop keeps the 56px touch target. */
function StepButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Icon icon={icon} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  disabled: { opacity: 0.4 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    padding: space[1] / 2,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  value: {
    ...typography.label,
    minWidth: 28,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});
