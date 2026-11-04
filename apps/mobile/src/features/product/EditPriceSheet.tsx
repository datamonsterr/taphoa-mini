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

import { BarcodeField } from '@/features/enroll/BarcodeField';
import { validBarcode } from '@/features/camera/barcode';

import { strings } from './strings';

const MAX_DIGITS = 9;
const BOARD_KEY_DIAMETER = 68;

const keypadLabels = (t: (key: string) => string) => ({
  delete: t('keypad.delete'),
});

type EditPriceSheetProps = {
  price: number;
  onSave: (price: number, barcode?: string) => void;
  barcode?: string;
  barcodeError?: string;
  onBarcodeChange?: () => void;
  saving?: boolean;
  onClose: () => void;
};

/** Keypad sheet to type a new selling price. */
export const EditPriceSheet = memo(function EditPriceSheet({
  price,
  barcode,
  barcodeError,
  onBarcodeChange,
  saving = false,
  onSave,
  onClose,
}: EditPriceSheetProps) {
  const t = useT(strings);
  const padLabels = useLabels(strings, keypadLabels);
  const keyDiameter = useKeypadDiameter(BOARD_KEY_DIAMETER);
  const [code, setCode] = useState(barcode ?? '');
  const [digits, setDigits] = useState(String(price));
  const amount = Number(digits || 0);
  const onKey = useCallback(
    (key: KeypadKeyId) =>
      setDigits((value) => applyKey(value, key, MAX_DIGITS)),
    [],
  );
  const save = () =>
    barcode === undefined ? onSave(amount) : onSave(amount, code);
  return (
    <Sheet
      onClose={onClose}
      footer={
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('save')}
          disabled={amount === 0 || saving || (!!code && !validBarcode(code))}
          onPress={save}
        />
      }
    >
      {barcode !== undefined ? (
        <BarcodeField
          value={code}
          error={barcodeError}
          disabled={saving}
          onChange={(next) => {
            setCode(next);
            onBarcodeChange?.();
          }}
        />
      ) : null}
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
