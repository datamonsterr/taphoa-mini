import { ChevronRight, UserRound } from '@/components/icons';
import { View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import type { Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors } from '@/theme';

import { debtStrings } from '../debts/strings';
import { formatCustomerPhone, initialOf } from '../debts/customerRow';
import { styles } from './payStyles';
import { payStrings } from './strings';

type Props = {
  customer: Customer | null;
  total: number;
  paidNow: number;
  roundPaid: number;
  creditAmount: number;
  invalidPaid: boolean;
  onPickCustomer: () => void;
  onPaid: (amount: number) => void;
  onOther: () => void;
};

/** "Ghi nợ" card: the debtor, the part paid now and the resulting debt. */
export function CreditPanel({
  customer,
  total,
  paidNow,
  roundPaid,
  creditAmount,
  invalidPaid,
  onPickCustomer,
  onPaid,
  onOther,
}: Props) {
  const t = useT(debtStrings);
  const payT = useT(payStrings);
  return (
    <View style={styles.cashCard}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={
          customer
            ? `${customer.name}, ${fill(payT('credit.currentDebt'), { amount: formatVnd(customer.balance) })}${customer.phone ? `, ${customer.phone}` : ''}. ${t('change')}`
            : t('choose')
        }
        onPress={onPickCustomer}
        style={styles.customerRow}
      >
        {customer ? (
          <View style={styles.customerAvatar}>
            <Text style={styles.customerInitial}>
              {initialOf(customer.name)}
            </Text>
          </View>
        ) : (
          <Icon icon={UserRound} color={colors.accent} />
        )}
        <View style={styles.customerText}>
          <Text style={styles.customerName}>
            {customer?.name ?? t('choose')}
          </Text>
          {customer ? (
            <>
              <Text style={styles.caption}>
                {fill(payT('credit.currentDebt'), {
                  amount: formatVnd(customer.balance),
                })}
              </Text>
              {customer.phone ? (
                <Text style={styles.caption}>
                  {formatCustomerPhone(customer.phone)}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
        {customer ? (
          <>
            <Text style={styles.changeCustomer}>{payT('credit.change')}</Text>
            <Icon icon={ChevronRight} size={20} color={colors.accent} />
          </>
        ) : null}
      </PressableScale>
      <View style={styles.paidRow}>
        <Text style={styles.customerName}>{t('paidNow')}</Text>
        <View style={styles.paidChips}>
          {[0, ...(roundPaid > 0 ? [roundPaid] : [])].map((amount) => (
            <PressableScale
              key={amount}
              accessibilityRole="radio"
              accessibilityLabel={formatVnd(amount)}
              accessibilityState={{ checked: paidNow === amount }}
              aria-checked={paidNow === amount}
              onPress={() => onPaid(amount)}
              style={[styles.paidChip, paidNow === amount && styles.chipOn]}
            >
              <Text
                style={[
                  styles.customerName,
                  paidNow === amount && styles.chipTextOn,
                ]}
              >
                {amount === 0
                  ? formatVnd(0)
                  : formatVnd(amount).replace('đ', '')}
              </Text>
            </PressableScale>
          ))}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={payT('credit.other')}
            onPress={onOther}
            style={styles.paidChip}
          >
            <Text style={styles.customerName}>
              {paidNow !== 0 && paidNow !== roundPaid
                ? formatVnd(paidNow)
                : payT('credit.other')}
            </Text>
          </PressableScale>
        </View>
      </View>
      {customer && !invalidPaid ? (
        <Text style={styles.newDebt}>
          {fill(payT('credit.newDebt'), {
            amount: formatVnd(customer.balance + creditAmount),
          })}
        </Text>
      ) : null}
      {invalidPaid ? (
        <Text accessibilityRole="alert">{t('invalidPaid')}</Text>
      ) : null}
      {customer &&
      paidNow < total &&
      customer.credit_limit !== null &&
      customer.balance + total - paidNow > customer.credit_limit ? (
        <Text accessibilityRole="alert">{t('overLimit')}</Text>
      ) : null}
    </View>
  );
}
