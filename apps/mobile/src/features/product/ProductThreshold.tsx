import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { CheckButton, Text } from '@/components/ui';
import { usePatchProduct } from '@/lib/api/hooks';
import type { Product } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, radius, space, scaleText, useFontScale } from '@/theme';

import { strings } from './strings';

export function ProductThreshold({ product }: { product: Product }) {
  const t = useT(strings);
  const scale = useFontScale();
  const patch = usePatchProduct();
  const [value, setValue] = useState(
    product.low_stock_threshold?.toString() ?? '',
  );
  const threshold = value.trim() === '' ? null : Number(value);
  const valid =
    threshold === null ||
    (/^\d+$/.test(value) &&
      Number.isInteger(threshold) &&
      threshold >= 0 &&
      threshold <= 100000);
  return (
    <View style={styles.form}>
      <Text>{t('override')}</Text>
      <TextInput
        accessibilityLabel={t('override')}
        value={value}
        onChangeText={setValue}
        editable={!patch.isPending}
        keyboardType="number-pad"
        style={[
          styles.input,
          scaleText({ fontSize: 18, lineHeight: 24 }, scale),
        ]}
      />
      <CheckButton
        variant="ink"
        block
        accessibilityLabel={t('saveThreshold')}
        disabled={
          !valid || patch.isPending || threshold === product.low_stock_threshold
        }
        onPress={() => {
          if (valid)
            patch.mutate({
              id: product.id,
              patch: { low_stock_threshold: threshold },
            });
        }}
      />
      {patch.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('thresholdSaveError')}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  form: { gap: space[2] },
  input: {
    minHeight: 56,
    borderRadius: radius.md,
    paddingHorizontal: space[4],
    backgroundColor: colors.surface,
    color: colors.ink,
  },
  error: { color: colors.danger },
});
