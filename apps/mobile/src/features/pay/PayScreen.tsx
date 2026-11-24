import { CustomerPicker } from '../debts/CustomerPicker';
import { debtStrings } from '../debts/strings';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, BookText } from '@/components/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import {
  CheckButton,
  CircleButton,
  Icon,
  MoneyText,
  PayToggle,
  PressableScale,
  Text,
} from '@/components/ui';
import type { PayMethod } from '@/components/ui';
import { useStore } from '@/lib/api';
import type { Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useLabels, useT } from '@/lib/i18n';
import { saleCode } from '@/lib/uuid';
import { useSettingsStore } from '@/stores/settings';
import { selectLines, selectTotal, useCartStore } from '@/stores/cart';
import { colors, space } from '@/theme';

import { CashPanel } from './CashPanel';
import { computeChange, quickCashOptions } from './change';
import { CreditPanel } from './CreditPanel';
import { OrderList } from './OrderList';
import { PaidSheet } from './PaidSheet';
import { styles } from './payStyles';
import { useSpokenTotal } from './speak';
import { payStrings } from './strings';
import { TransferPanel } from './TransferPanel';
import { useSaleSubmit } from './useSaleSubmit';
import { buildVietQr } from './vietqr';

/** How long the green "received" state shows before returning to the camera. */
export const SUCCESS_MS = 700;

const toggleLabels = (t: (key: string) => string) => ({
  group: t('toggle.group'),
  transfer: t('toggle.transfer'),
  cash: t('toggle.cash'),
  credit: t('toggle.credit'),
});

export function PayScreen() {
  const router = useRouter();
  const toggle = useLabels(payStrings, toggleLabels);
  const insets = useSafeAreaInsets();
  const lines = useCartStore(useShallow(selectLines));
  const total = useCartStore(selectTotal);
  const store = useStore({ live: true });
  const { saleId, saving, saveError, done, submit } = useSaleSubmit();

  const t = useT(debtStrings);
  const payT = useT(payStrings);
  const [customPaid, setCustomPaid] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [picker, setPicker] = useState(false);
  const [paidText, setPaidText] = useState('0');
  const paidNow = Number(paidText || '0');
  const invalidPaid =
    !/^\d*$/.test(paidText) ||
    !Number.isSafeInteger(paidNow) ||
    paidNow > total;
  const { method: paramMethod } = useLocalSearchParams<{ method?: string }>();
  const initialMethod: PayMethod =
    paramMethod === 'cash' || paramMethod === 'credit'
      ? paramMethod
      : 'transfer';
  const [method, setMethod] = useState<PayMethod>(initialMethod);
  const [tendered, setTendered] = useState<number | null>(null);
  const code = saleCode(saleId);

  const bank = store.data?.bank_account;
  const memo = `${store.data?.sales_memo_prefix ?? 'TH'} ${code}`;
  const payload = useMemo(
    () =>
      bank
        ? buildVietQr({
            bankBin: bank.bank_bin,
            accountNumber: bank.account_number,
            amount: total,
            memo,
          })
        : null,
    [bank, total, memo],
  );

  const cashGiven = tendered ?? total;
  // Tapping the selected note again clears it: back to paying the exact amount.
  const pickNote = useCallback(
    (amount: number) => setTendered((now) => (now === amount ? null : amount)),
    [],
  );
  const change = computeChange(total, cashGiven);
  const options = useMemo(() => quickCashOptions(), []);
  const roundStep = total >= 10000 ? 10000 : total >= 1000 ? 1000 : 100;
  const roundPaid = Math.min(
    total,
    Math.max(roundStep, Math.floor(total / roundStep) * roundStep),
  );
  const speakTotal = useSettingsStore((s) => s.speakTotal);
  useSpokenTotal({
    enabled: speakTotal,
    total,
    change: method === 'cash' && tendered !== null ? change : 0,
  });
  const creditAmount = Math.max(0, total - paidNow);
  const confirmDisabled =
    saving ||
    done ||
    lines.length === 0 ||
    (method === 'cash' && cashGiven < total) ||
    (method === 'credit' && (!customer || invalidPaid)) ||
    picker ||
    customPaid;
  const creditLabel = fill(payT('credit.confirm'), {
    amount: formatVnd(creditAmount),
  });

  const back = useCallback(() => router.back(), [router]);
  const retryStore = useCallback(() => void store.refetch(), [store]);
  const addBank = useCallback(() => router.push('/account'), [router]);

  const leave = useCallback(() => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  }, [router]);

  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(leave, SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [done, leave]);

  const received = useCallback(
    () => submit({ lines, total, method, customer, paidNow, cashGiven, memo }),
    [submit, lines, total, method, customer, paidNow, cashGiven, memo],
  );

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: space[4] + insets.top,
          paddingBottom: space[4] + insets.bottom,
        },
      ]}
    >
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel="Quay lại giỏ hàng"
          onPress={back}
        />
        <Text accessibilityRole="header" style={styles.title}>
          {payT('title')}
        </Text>
      </View>
      <PayToggle
        value={method}
        onChange={(next) => {
          setMethod(next);
          if (next === 'credit' && !customer) setPicker(true);
        }}
        labels={toggle}
      />

      <MoneyText
        testID="pay-total"
        amount={total}
        variant="total"
        style={styles.total}
      />

      {method === 'credit' ? (
        <CreditPanel
          customer={customer}
          total={total}
          paidNow={paidNow}
          roundPaid={roundPaid}
          creditAmount={creditAmount}
          invalidPaid={invalidPaid}
          onPickCustomer={() => setPicker(true)}
          onPaid={(amount) => setPaidText(String(amount))}
          onOther={() => setCustomPaid(true)}
        />
      ) : method === 'transfer' ? (
        <TransferPanel
          isPending={store.isPending}
          isError={store.isError}
          bank={bank}
          payload={payload}
          total={total}
          onRetry={retryStore}
          onAddBank={addBank}
        />
      ) : (
        <CashPanel
          options={options}
          tendered={tendered}
          change={change}
          onPick={pickNote}
        />
      )}

      <OrderList lines={lines} />

      {saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Không lưu được đơn. Giỏ hàng vẫn còn, thử lại.
        </Text>
      ) : null}
      {method === 'credit' ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={creditLabel}
          onPress={received}
          disabled={confirmDisabled}
          accessibilityState={{ disabled: confirmDisabled }}
          style={[styles.creditButton, confirmDisabled && styles.disabled]}
        >
          <Icon icon={BookText} size={28} color={colors.onInk} />
          <Text style={styles.creditButtonText}>{creditLabel}</Text>
        </PressableScale>
      ) : (
        <CheckButton
          variant="success"
          accessibilityLabel="Đã nhận tiền"
          onPress={received}
          disabled={confirmDisabled}
          block
          xl
        />
      )}
      {customPaid ? (
        <PaidSheet
          paidText={paidText}
          invalidPaid={invalidPaid}
          onChange={setPaidText}
          onClose={() => setCustomPaid(false)}
        />
      ) : null}

      {picker ? (
        <CustomerPicker
          createLabel={t('picker.creditCreate')}
          onClose={() => setPicker(false)}
          onSelect={(picked) => {
            setCustomer(picked);
            setPicker(false);
          }}
        />
      ) : null}

      {done ? (
        <Animated.View
          entering={ZoomIn}
          accessibilityLabel="Đã nhận tiền xong"
          accessible
          style={styles.success}
        >
          <View style={styles.successDisc}>
            <Icon icon={Check} size={64} color={colors.onInk} />
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}
