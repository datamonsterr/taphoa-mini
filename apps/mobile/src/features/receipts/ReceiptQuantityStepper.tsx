import { Minus, Plus } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { CircleButton, Text } from '@/components/ui';
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
      <CircleButton
        icon={Minus}
        accessibilityLabel={`${t('decrement')}: ${name}`}
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
      <CircleButton
        icon={Plus}
        accessibilityLabel={`${t('increment')}: ${name}`}
        disabled={disabled || value >= 2147483647}
        onPress={() => onChange(value + 1)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
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
