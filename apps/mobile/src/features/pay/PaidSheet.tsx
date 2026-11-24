import { TextInput } from 'react-native';

import { Keypad, PressableScale, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { applyKey } from '@/components/ui/keypad';

import { DebtSheet } from '../debts/DebtSheet';
import { debtStrings } from '../debts/strings';
import { styles } from './payStyles';
import { payStrings } from './strings';

type Props = {
  paidText: string;
  invalidPaid: boolean;
  onChange: (update: string | ((value: string) => string)) => void;
  onClose: () => void;
};

/** Sheet to type the amount paid now when the customer takes the rest on credit. */
export function PaidSheet({ paidText, invalidPaid, onChange, onClose }: Props) {
  const t = useT(debtStrings);
  const payT = useT(payStrings);
  return (
    <DebtSheet
      title={t('paidNow')}
      onClose={onClose}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={payT('credit.applyPaid')}
          disabled={invalidPaid}
          onPress={onClose}
          style={[styles.creditButton, invalidPaid && styles.disabled]}
        >
          <Text style={styles.creditButtonText}>
            {payT('credit.applyPaid')}
          </Text>
        </PressableScale>
      }
    >
      <TextInput
        accessibilityLabel={t('paidNow')}
        value={paidText}
        onChangeText={onChange}
        keyboardType="number-pad"
        style={styles.paidInput}
      />
      {invalidPaid ? (
        <Text accessibilityRole="alert">{t('invalidPaid')}</Text>
      ) : null}
      <Keypad
        diameter={64}
        onKey={(key) => onChange((value) => applyKey(value, key, 12))}
      />
    </DebtSheet>
  );
}
