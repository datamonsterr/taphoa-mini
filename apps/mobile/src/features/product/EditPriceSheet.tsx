import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CheckButton } from '@/components/ui/CheckButton';
import { Keypad } from '@/components/ui/Keypad';
import { applyKey, type KeypadKeyId } from '@/components/ui/keypad';
import { MoneyText } from '@/components/ui/MoneyText';
import { Sheet } from '@/components/ui/Sheet';
import { useKeypadDiameter } from '@/components/ui/useKeypadDiameter';
import { useLabels, useT } from '@/lib/i18n';
import { space } from '@/theme';

import { strings } from './strings';

const MAX_DIGITS = 9;
const BOARD_KEY_DIAMETER = 68;

const keypadLabels = (t: (key: string) => string) => ({
  delete: t('keypad.delete'),
});

type EditPriceSheetProps = {
  price: number;
  onSave: (price: number) => void;
  onClose: () => void;
};

/** Keypad sheet to type a new selling price. */
export const EditPriceSheet = memo(function EditPriceSheet({
  price,
  onSave,
  onClose,
}: EditPriceSheetProps) {
  const t = useT(strings);
  const padLabels = useLabels(strings, keypadLabels);
  const keyDiameter = useKeypadDiameter(BOARD_KEY_DIAMETER);
  const [digits, setDigits] = useState(String(price));
  const amount = Number(digits || 0);
  const onKey = useCallback(
    (key: KeypadKeyId) =>
      setDigits((value) => applyKey(value, key, MAX_DIGITS)),
    [],
  );
  const save = useCallback(() => onSave(amount), [onSave, amount]);
  return (
    <Sheet
      onClose={onClose}
      footer={
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('save')}
          disabled={amount === 0}
          onPress={save}
        />
      }
    >
      <View style={styles.display}>
        <MoneyText amount={amount} testID="edit-price-display" />
      </View>
      <Keypad onKey={onKey} diameter={keyDiameter} labels={padLabels} />
    </Sheet>
  );
});

const styles = StyleSheet.create({
  display: { alignItems: 'center', paddingVertical: space[2] },
});
