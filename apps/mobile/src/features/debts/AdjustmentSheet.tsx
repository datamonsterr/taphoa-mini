import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { CheckButton, Text } from '@/components/ui';
import { useCreateDebtAdjustment, type Customer } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { colors, typography } from '@/theme';

import { digitsOnly } from './amount';
import { DebtInput } from './DebtInput';
import { DebtSheet } from './DebtSheet';
import { Options } from './Options';
import { debtStrings } from './strings';

type Direction = 'increase' | 'decrease';

/**
 * "Điều chỉnh" (Lead only): a signed correction of the balance with a required reason. The
 * Idempotency-Key belongs to this open sheet, so a retry replays; editing starts a new operation.
 */
export function AdjustmentSheet({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const t = useT(debtStrings);
  const adjust = useCreateDebtAdjustment(customer.id);
  const [direction, setDirection] = useState<Direction>('increase');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newUuid);
  const amount = Number(amountText || '0');
  const valid =
    Number.isSafeInteger(amount) && amount > 0 && reason.trim().length > 0;
  const edited = () => {
    setKey(newUuid());
    adjust.reset();
  };

  const submit = () =>
    adjust.mutate(
      {
        amount: direction === 'increase' ? amount : -amount,
        reason: reason.trim(),
        idempotencyKey: key,
      },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          onClose();
        },
      },
    );

  return (
    <DebtSheet
      title={t('adjust.title')}
      onClose={onClose}
      footer={
        <CheckButton
          variant="ink"
          block
          accessibilityLabel={t('adjust.confirm')}
          disabled={!valid || adjust.isPending}
          onPress={submit}
        />
      }
    >
      <Options<Direction>
        label={t('adjust.direction')}
        value={direction}
        options={[
          { value: 'increase', label: t('adjust.increase') },
          { value: 'decrease', label: t('adjust.decrease') },
        ]}
        onChange={(next) => {
          setDirection(next);
          edited();
        }}
      />
      <DebtInput
        label={t('adjust.amount')}
        keyboardType="number-pad"
        value={amountText}
        onChangeText={(text) => {
          setAmountText(digitsOnly(text));
          edited();
        }}
      />
      <DebtInput
        label={t('adjust.reason')}
        maxLength={200}
        value={reason}
        onChangeText={(text) => {
          setReason(text);
          edited();
        }}
      />
      {adjust.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('adjust.error')}
        </Text>
      ) : null}
    </DebtSheet>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.caption, color: colors.danger },
});
