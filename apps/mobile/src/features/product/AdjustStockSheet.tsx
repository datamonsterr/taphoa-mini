import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { CheckButton, PressableScale, Sheet, Text } from '@/components/ui';
import { useAdjustStock } from '@/lib/api/hooks';
import type { Product, StockAdjustment } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import {
  colors,
  radius,
  space,
  typography,
  scaleText,
  useFontScale,
} from '@/theme';

import { strings } from './strings';

export function AdjustStockSheet({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  const t = useT(strings);
  const scale = useFontScale();
  const adjust = useAdjustStock(product.id);
  const [mode, setMode] = useState<'count' | 'delta'>('count');
  const [count, setCount] = useState(
    String(Math.max(0, product.stock_quantity ?? 0)),
  );
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const value = mode === 'count' ? count : delta;
  const number = Number(value);
  const valid =
    /^[+-]?\d+$/.test(value) &&
    Number.isInteger(number) &&
    number <= 2147483647 &&
    (mode === 'count' ? number >= 0 : number >= -2147483648 && number !== 0);
  // Keep the same object for a retry of an unchanged draft: the hook retains its operation key.
  const input = useMemo<StockAdjustment>(
    () => ({
      [mode]: Number(mode === 'count' ? count : delta),
      ...(note.trim() ? { note: note.trim() } : {}),
    }),
    [mode, count, delta, note],
  );
  const inputStyle = [
    styles.input,
    scaleText({ fontSize: 18, lineHeight: 24 }, scale),
  ];
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <Sheet onClose={onClose}>
        <Text accessibilityRole="header" style={styles.title}>
          {t('adjust')}
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t('adjust')}
          style={styles.modes}
        >
          {(['count', 'delta'] as const).map((item) => (
            <PressableScale
              key={item}
              accessibilityRole="radio"
              accessibilityLabel={t(`${item}Mode`)}
              accessibilityState={{
                checked: mode === item,
                disabled: adjust.isPending,
              }}
              disabled={adjust.isPending}
              onPress={() => setMode(item)}
              style={[styles.mode, mode === item && styles.selected]}
            >
              <Text style={mode === item ? styles.selectedText : undefined}>
                {t(`${item}Mode`)}
              </Text>
            </PressableScale>
          ))}
        </View>
        <Text>{t(mode)}</Text>
        <TextInput
          accessibilityLabel={t(mode)}
          value={value}
          onChangeText={mode === 'count' ? setCount : setDelta}
          editable={!adjust.isPending}
          keyboardType={
            mode === 'count' ? 'number-pad' : 'numbers-and-punctuation'
          }
          style={inputStyle}
        />
        <Text>{t('note')}</Text>
        <TextInput
          accessibilityLabel={t('note')}
          value={note}
          onChangeText={setNote}
          editable={!adjust.isPending}
          style={inputStyle}
        />
        {adjust.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('stockSaveError')}
          </Text>
        ) : null}
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('saveStock')}
          disabled={!valid || adjust.isPending}
          onPress={() => {
            if (valid) adjust.mutate(input, { onSuccess: onClose });
          }}
        />
      </Sheet>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  title: { ...typography.heading, color: colors.ink },
  input: {
    minHeight: 56,
    paddingHorizontal: space[4],
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.md,
    color: colors.ink,
  },
  modes: { flexDirection: 'row', gap: space[2] },
  mode: {
    flex: 1,
    minHeight: 56,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.surfaceSoft,
  },
  selected: { backgroundColor: colors.ink },
  selectedText: { color: colors.onInk },
  error: { color: colors.danger },
});
