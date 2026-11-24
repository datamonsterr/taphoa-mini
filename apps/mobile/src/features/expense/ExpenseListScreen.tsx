import { router } from 'expo-router';
import { useState } from 'react';

import { MoneyText, PressableScale, Text } from '@/components/ui';
import { useMembership } from '@/features/auth/useMembership';
import { useExpenses, type Expense } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatVnd } from '@/lib/format';

import { Action, BackPill, Page, saleStamp, styles } from '../sales/kit';
import { ExpenseEditDialog } from './ExpenseEditDialog';
import { expenseStrings } from './strings';

/**
 * Recent expenses. The Lead opens any of them to edit or delete; a seller opens only
 * their own to edit (the server answers 403 for the rest, and delete is Lead-only).
 */
export function ExpenseListScreen() {
  const t = useT(expenseStrings);
  const membership = useMembership();
  const isLead = membership?.member.role === 'lead';
  const expenses = useExpenses();
  const [editing, setEditing] = useState<Expense | null>(null);
  const items = expenses.data?.items ?? [];

  return (
    <Page>
      <BackPill
        label={t('back')}
        text={t('reports')}
        onPress={() => router.replace('/dashboard')}
      />
      <Text accessibilityRole="header" style={styles.heading}>
        {t('listTitle')}
      </Text>
      {expenses.isPending ? (
        <Text accessibilityRole="progressbar">{t('loading')}</Text>
      ) : null}
      {expenses.isError ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('loadError')}
          </Text>
          <Action label={t('retry')} onPress={() => void expenses.refetch()} />
        </>
      ) : null}
      {!expenses.isPending && !expenses.isError && !items.length ? (
        <Text>{t('empty')}</Text>
      ) : null}
      {items.map((expense) => {
        const label = `${t(`cat.${expense.category}`)}, ${formatVnd(expense.amount)}`;
        const body = (
          <>
            <Text style={styles.label}>
              {t(`cat.${expense.category}`)} · {saleStamp(expense.spent_at)}
            </Text>
            {expense.note ? (
              <Text style={styles.body}>{expense.note}</Text>
            ) : null}
            <MoneyText amount={expense.amount} variant="label" />
          </>
        );
        return isLead || expense.member_id === membership?.member.id ? (
          <PressableScale
            key={expense.id}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => setEditing(expense)}
            style={styles.card}
          >
            {body}
          </PressableScale>
        ) : (
          <PressableScale
            key={expense.id}
            disabled
            accessibilityLabel={label}
            style={styles.card}
          >
            {body}
          </PressableScale>
        );
      })}
      {editing ? (
        <ExpenseEditDialog
          key={editing.id}
          expense={editing}
          canDelete={isLead}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}
