import { Minus, Plus } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { CircleButton, Text } from '@/components/ui';
import { usePatchStore } from '@/lib/api/hooks';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { strings } from './strings';

export function StockThresholdRow({ value }: { value: number }) {
  const t = useT(strings);
  const patch = usePatchStore();
  const change = (delta: number) => {
    const next = value + delta;
    if (!patch.isPending && next >= 0 && next <= 100000)
      patch.mutate({ low_stock_threshold: next });
  };
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t('stockThreshold')}</Text>
      <View style={styles.stepper}>
        <CircleButton
          icon={Minus}
          accessibilityLabel={t('stockDecrease')}
          disabled={value <= 0 || patch.isPending}
          onPress={() => change(-1)}
        />
        <Text
          accessibilityLabel={`${t('stockThreshold')} ${value}`}
          accessibilityLiveRegion="polite"
          style={styles.value}
        >
          {value}
        </Text>
        <CircleButton
          icon={Plus}
          accessibilityLabel={t('stockIncrease')}
          disabled={value >= 100000 || patch.isPending}
          onPress={() => change(1)}
        />
      </View>
      {patch.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('stockSaveError')}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: space[4],
    gap: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  label: { ...typography.label, color: colors.ink },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    alignSelf: 'flex-start',
  },
  value: {
    ...typography.heading,
    minWidth: 56,
    textAlign: 'center',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  error: { color: colors.danger },
});
