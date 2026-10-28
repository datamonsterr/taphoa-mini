import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Text, MoneyText } from '@/components/ui';
import { useIsLead } from '@/features/auth/useMembership';
import { useSale, useVoidSale } from '@/lib/api/salesActions';
import { useT } from '@/lib/i18n';
import { transactionStrings } from '@/features/dashboard/transactionStrings';
import { Action, ConfirmDialog, Field, Page, styles } from './kit';

export function SaleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT(transactionStrings);
  const query = useSale(id);
  const sale = query.data;
  const mutation = useVoidSale(id);
  const lead = useIsLead();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const valid = reason.trim().length > 0 && reason.trim().length <= 200;
  return (
    <Page>
      <Action label={t('recent')} onPress={() => router.replace('/sales')} />
      <Text accessibilityRole="header" style={styles.heading}>
        {t('detail')}
        {sale ? ` · ${sale.code}` : ''}
      </Text>
      {query.isPending ? (
        <Text accessibilityRole="progressbar">{t('loading')}</Text>
      ) : null}
      {query.isError ? (
        <>
          <Text accessibilityRole="alert">{t('error')}</Text>
          <Action label={t('retry')} onPress={() => void query.refetch()} />
        </>
      ) : null}
      {sale ? (
        <>
          <Text>
            {sale.business_date} · {t(sale.payment_method)}
          </Text>
          <Text testID="sale-status">{t(sale.status)}</Text>
          {sale.lines.map((line) => (
            <View key={line.id} style={styles.card}>
              <Text style={styles.label}>
                {line.product_name ?? line.manual_label ?? line.product_id} ×{' '}
                {line.quantity}
              </Text>
              <MoneyText amount={line.line_total} variant="label" />
            </View>
          ))}
          <MoneyText amount={sale.total} />
          {sale.void?.reason ? <Text>{sale.void.reason}</Text> : null}
          {lead && sale.status === 'completed' ? (
            <>
              <Text style={styles.body}>{t('explanation')}</Text>
              <Field
                label={t('reason')}
                value={reason}
                onChangeText={(value) => {
                  setReason(value);
                  setConfirming(false);
                }}
                maxLength={200}
                multiline
                editable={!mutation.isPending}
              />
              {mutation.isError ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {t('failed')}
                </Text>
              ) : null}
              {!confirming ? (
                <Action
                  label={t('void')}
                  disabled={!valid}
                  danger
                  onPress={() => setConfirming(true)}
                />
              ) : (
                <ConfirmDialog
                  onClose={() => {
                    if (!mutation.isPending) setConfirming(false);
                  }}
                >
                  <Text accessibilityRole="header" style={styles.heading}>
                    {t('question')}
                  </Text>
                  <Text>{reason.trim()}</Text>
                  <Text>{t('refund')}</Text>
                  <MoneyText
                    amount={sale.total - sale.credit_amount}
                    variant="label"
                  />
                  {sale.credit_amount > 0 ? (
                    <>
                      <Text>{t('creditReversal')}</Text>
                      <MoneyText amount={sale.credit_amount} variant="label" />
                    </>
                  ) : null}
                  <Action
                    label={t('cancel')}
                    disabled={mutation.isPending}
                    onPress={() => setConfirming(false)}
                  />
                  <Action
                    label={mutation.isPending ? t('loading') : t('confirm')}
                    danger
                    disabled={!valid || mutation.isPending}
                    onPress={() => mutation.mutate({ reason: reason.trim() })}
                  />
                </ConfirmDialog>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
