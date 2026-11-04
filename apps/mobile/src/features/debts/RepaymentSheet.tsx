import * as Haptics from 'expo-haptics';
import { onlineManager } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { CheckButton, Text } from '@/components/ui';
import { useCreateRepayment, type Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { colors, typography } from '@/theme';

import { digitsOnly } from './amount';
import { DebtInput } from './DebtInput';
import { DebtSheet } from './DebtSheet';
import { Options } from './Options';
import { debtStrings } from './strings';

type Method = 'cash' | 'transfer';

/**
 * "Thu nợ": how much the customer paid and how. The amount starts at the whole balance. More than
 * the balance only warns: the server accepts it and the extra becomes customer credit.
 * The Idempotency-Key belongs to this open sheet, so a retry after a lost response replays
 * instead of paying twice; editing the amount or method starts a new operation.
 */
export function RepaymentSheet({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const t = useT(debtStrings);
  const repay = useCreateRepayment(customer.id);
  const [amountText, setAmountText] = useState(
    customer.balance > 0 ? String(customer.balance) : '',
  );
  const [method, setMethod] = useState<Method>('cash');
  const [key, setKey] = useState(newUuid);
  const amount = Number(amountText || '0');
  const valid = Number.isSafeInteger(amount) && amount > 0;
  const edited = () => {
    setKey(newUuid());
    setOffline(false);
    repay.reset();
  };

  const [offline, setOffline] = useState(false);
  const submit = () => {
    // Offline the repayment is refused with a message, never left waiting: leaving the screen
    // would drop it while the cash is already in hand. The sheet keeps the amount for a retry.
    if (!onlineManager.isOnline()) {
      setOffline(true);
      return;
    }
    setOffline(false);
    repay.mutate(
      { amount, method, idempotencyKey: key },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          onClose();
        },
        onError: () => setOffline(!onlineManager.isOnline()),
      },
    );
  };

  return (
    <DebtSheet
      title={t('repay.title')}
      onClose={onClose}
      footer={
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('repay.confirm')}
          disabled={!valid || repay.isPending}
          onPress={submit}
        />
      }
    >
      <DebtInput
        label={t('repay.amount')}
        keyboardType="number-pad"
        value={amountText}
        onChangeText={(text) => {
          setAmountText(digitsOnly(text));
          edited();
        }}
      />
      <Text accessibilityLiveRegion="polite" style={styles.preview}>
        {formatVnd(valid ? amount : 0)}
      </Text>
      <Options<Method>
        label={t('repay.method')}
        value={method}
        options={[
          { value: 'cash', label: t('method.cash') },
          { value: 'transfer', label: t('method.transfer') },
        ]}
        onChange={(next) => {
          setMethod(next);
          edited();
        }}
      />
      {valid && amount > Math.max(customer.balance, 0) ? (
        <Text accessibilityRole="alert" style={styles.warning}>
          {t('repay.over')}
        </Text>
      ) : null}
      {offline ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('repay.offline')}
        </Text>
      ) : repay.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('repay.error')}
        </Text>
      ) : null}
    </DebtSheet>
  );
}

const styles = StyleSheet.create({
  preview: { ...typography.heading, color: colors.ink, textAlign: 'right' },
  warning: { ...typography.caption, color: colors.warning },
  error: { ...typography.caption, color: colors.danger },
});
