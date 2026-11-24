import { useState } from 'react';
import { View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import {
  useDeleteExpense,
  useUpdateExpense,
  type Expense,
  type ExpenseCategory,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, space } from '@/theme';

import { Action, ConfirmDialog, Field, styles } from '../sales/kit';
import { expenseStrings } from './strings';

const CATEGORIES: readonly ExpenseCategory[] = [
  'nhap_hang',
  'dien',
  'nuoc',
  'khac',
];

/** Edit amount, category and note of one expense; the Lead can also delete it after confirming. */
export function ExpenseEditDialog({
  expense,
  canDelete,
  onClose,
}: {
  expense: Expense;
  canDelete: boolean;
  onClose: () => void;
}) {
  const t = useT(expenseStrings);
  const [digits, setDigits] = useState(String(expense.amount));
  const [category, setCategory] = useState<ExpenseCategory>(expense.category);
  const [note, setNote] = useState(expense.note ?? '');
  const [asking, setAsking] = useState(false);
  const update = useUpdateExpense();
  const remove = useDeleteExpense();
  const busy = update.isPending || remove.isPending;
  const amount = Number(digits);

  const save = () =>
    update.mutate(
      {
        id: expense.id,
        amount,
        category,
        note: note.trim() === '' ? null : note.trim(),
      },
      { onSuccess: onClose },
    );
  const confirmDelete = () => remove.mutate(expense.id, { onSuccess: onClose });

  if (asking) {
    return (
      <ConfirmDialog onClose={() => !busy && setAsking(false)}>
        <Text accessibilityRole="header" style={styles.heading}>
          {t('deleteQuestion')}
        </Text>
        <Text>{t('deleteHint')}</Text>
        {remove.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('deleteError')}
          </Text>
        ) : null}
        <Action
          label={t('deleteYes')}
          danger
          disabled={busy}
          onPress={confirmDelete}
        />
        <Action
          label={t('deleteNo')}
          disabled={busy}
          onPress={() => setAsking(false)}
        />
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog onClose={() => !busy && onClose()}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t('editTitle')}
      </Text>
      <Field
        label={t('amountField')}
        value={digits}
        keyboardType="number-pad"
        maxLength={10}
        onChangeText={(value) => setDigits(value.replace(/\D/g, ''))}
      />
      <View
        accessibilityRole="radiogroup"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
      >
        {CATEGORIES.map((id) => (
          <PressableScale
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={t(`cat.${id}`)}
            accessibilityState={{ checked: category === id }}
            pressedScale={0.96}
            onPress={() => setCategory(id)}
            style={[
              styles.action,
              {
                flex: 1,
                minWidth: 72,
                backgroundColor: category === id ? colors.ink : colors.surface,
              },
            ]}
          >
            <Text
              style={[
                styles.actionText,
                { color: category === id ? colors.onInk : colors.ink },
              ]}
            >
              {t(`cat.${id}`)}
            </Text>
          </PressableScale>
        ))}
      </View>
      <Field
        label={t('noteField')}
        value={note}
        maxLength={500}
        multiline
        onChangeText={setNote}
      />
      {update.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('editError')}
        </Text>
      ) : null}
      <Action
        label={t('saveChanges')}
        disabled={amount <= 0 || busy}
        onPress={save}
      />
      {canDelete ? (
        <Action
          label={t('delete')}
          danger
          disabled={busy}
          onPress={() => setAsking(true)}
        />
      ) : null}
      <Action label={t('closeEdit')} disabled={busy} onPress={onClose} />
    </ConfirmDialog>
  );
}
