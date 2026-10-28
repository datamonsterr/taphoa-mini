import { Check } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { applyKey, Icon, Keypad, PressableScale, Text } from '@/components/ui';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';
import { strings } from './strings';

export function ReceiptPricePill({
  name,
  price,
  onPress,
  editing = false,
  disabled = false,
}: {
  name: string;
  price: number;
  onPress: () => void;
  editing?: boolean;
  disabled?: boolean;
}) {
  const t = useT(strings);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${t('unitPrice')}: ${name}, ${formatVnd(price)}, ${t('tapToEdit')}`}
      accessibilityState={{ disabled, selected: editing }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.pill,
        price <= 0 && styles.unknown,
        editing && styles.editing,
      ]}
    >
      <Text style={[typography.label, price <= 0 && { color: colors.warning }]}>
        {formatVnd(price)}
      </Text>
    </PressableScale>
  );
}

export function ReceiptPriceKeypad({
  name,
  price,
  onChange,
  onDone,
}: {
  name: string;
  price: number;
  onChange: (price: number) => void;
  onDone: () => void;
}) {
  const t = useT(strings);
  return (
    <View style={styles.panel}>
      <View style={styles.heading}>
        <Text style={styles.name}>
          {t('unitPrice')} · {name}
        </Text>
        <Text
          accessibilityLabel={t('unitPrice')}
          accessibilityLiveRegion="polite"
          style={typography.price}
        >
          {formatVnd(price)}
        </Text>
      </View>
      <View style={styles.keypad}>
        <Keypad
          diameter={56}
          onKey={(key) =>
            onChange(Number(applyKey(String(Math.round(price)), key, 9)))
          }
        />
      </View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('done')}
        onPress={onDone}
        style={styles.done}
      >
        <Icon icon={Check} color={colors.onInk} />
        <Text style={styles.doneText}>{t('done')}</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 96,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  unknown: { backgroundColor: colors.warningSoft },
  editing: { borderWidth: 3, borderColor: colors.accent },
  panel: {
    padding: space[3],
    gap: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  name: { ...typography.caption, color: colors.inkMuted, flexShrink: 1 },
  // Keep three 56px keys per row; four keys would fit at 224px or wider.
  keypad: { width: 216, alignSelf: 'center' },
  done: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  doneText: { ...typography.label, color: colors.onInk },
});
