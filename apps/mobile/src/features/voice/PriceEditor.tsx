import { ChevronLeft } from 'lucide-react-native';
import { memo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  applyKey,
  CheckButton,
  CircleButton,
  Keypad,
  MoneyText,
  Text,
  useKeypadDiameter,
  type KeypadKeyId,
} from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { colors, space, typography } from '@/theme';

import { voiceStrings } from './strings';

/** The backend rejects unit prices outside 500..50,000,000 đồng. */
export const MIN_PRICE = 500;
export const MAX_PRICE = 50_000_000;

export type PriceEditorProps = {
  name: string;
  initial: number | null;
  onSave: (price: number) => void;
  onCancel: () => void;
};

/** Retypes one line's unit price on the same keypad the enroll and expense screens use. */
export const PriceEditor = memo(function PriceEditor({
  name,
  initial,
  onSave,
  onCancel,
}: PriceEditorProps) {
  const t = useT(voiceStrings);
  const diameter = useKeypadDiameter(68);
  const [digits, setDigits] = useState(initial ? String(initial) : '');
  const price = Number(digits || '0');
  const valid = price >= MIN_PRICE && price <= MAX_PRICE;
  return (
    <View testID="voice-price-editor" style={styles.root}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={t('close')}
          onPress={onCancel}
          testID="voice-price-back"
        />
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
          {fill(t('priceFor'), { name })}
        </Text>
        <View style={styles.balance} />
      </View>
      <MoneyText
        testID="voice-price-value"
        amount={price}
        variant="total"
        style={styles.value}
      />
      <Keypad
        diameter={diameter}
        labels={{ delete: 'Xóa' }}
        onKey={(key: KeypadKeyId) => setDigits((d) => applyKey(d, key, 8))}
      />
      <CheckButton
        variant="ink"
        accessibilityLabel={t('priceDone')}
        disabled={!valid}
        onPress={() => onSave(price)}
        block
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, gap: space[3] },
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  balance: { width: 56 },
  title: {
    ...typography.label,
    flex: 1,
    textAlign: 'center',
    color: colors.inkMuted,
  },
  value: { textAlign: 'center' },
});
