import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Text, MoneyText } from '@/components/ui';
import { useMembership } from '@/features/auth/useMembership';
import { isApiError } from '@/lib/api/errors';
import { useSale, useVoidSale } from '@/lib/api/salesActions';
import { businessDate } from '@/lib/date';
import { colors, space } from '@/theme';
import { fill, useT } from '@/lib/i18n';
import { transactionStrings } from '@/features/dashboard/transactionStrings';
import {
  Action,
  BackPill,
  ConfirmDialog,
  Field,
  Page,
  StatusPill,
  saleStamp,
  styles,
} from './kit';

export function SaleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT(transactionStrings);
  const query = useSale(id);
  const sale = query.data;
  const mutation = useVoidSale(id);
  const membership = useMembership();
  // Spec e4 M2: the Lead voids any sale; a seller only their own sale of the same business day.
  const canVoid =
    membership?.member.role === 'lead' ||
    (sale !== undefined &&
      membership?.member.id === sale.member_id &&
      sale.business_date === businessDate());
  const notFound = isApiError(query.error) && query.error.status === 404;
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const valid = reason.trim().length > 0 && reason.trim().length <= 200;
  return (
    <Page>
      <BackPill label={t('recent')} onPress={() => router.replace('/sales')} />
      <Text accessibilityRole="header" style={styles.heading}>
        {sale ? fill(t('saleTitle'), { code: sale.code }) : t('detail')}
      </Text>
      {query.isPending ? (
        <Text accessibilityRole="progressbar">{t('loading')}</Text>
      ) : null}
      {query.isError && notFound ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('notFound')}
          </Text>
          <Action
            label={t('toRecent')}
            onPress={() => router.replace('/sales')}
          />
        </>
      ) : null}
      {query.isError && !notFound ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('error')}
          </Text>
          <Action label={t('retry')} onPress={() => void query.refetch()} />
        </>
      ) : null}
      {sale ? (
        <>
          <Text style={styles.body}>
            {saleStamp(sale.sold_at)} · {t(sale.payment_method)}
          </Text>
          <StatusPill
            testID="sale-status"
            label={t(sale.status)}
            voided={sale.status === 'voided'}
          />
          {sale.lines.map((line) => (
            <View
              key={line.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: space[3],
              }}
            >
              <Text style={[styles.label, { flex: 1 }]}>
                {line.product_name ?? line.manual_label ?? line.product_id} ×{' '}
                {line.quantity}
              </Text>
              <MoneyText amount={line.line_total} variant="label" />
            </View>
          ))}
          <MoneyText amount={sale.total} />
          {sale.void?.reason ? (
            <Text style={{ color: colors.danger }}>
              {fill(t('voidedReason'), { reason: sale.void.reason })}
            </Text>
          ) : null}
          {canVoid && sale.status === 'completed' ? (
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
