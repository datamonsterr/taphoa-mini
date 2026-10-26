import { CustomerPicker } from '../debts/CustomerPicker';
import { debtStrings } from '../debts/strings';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, ChevronLeft, Landmark, Undo2 } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
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
import { useCreateSale, useStore } from '@/lib/api';
import type { CreateSaleRequest, Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useLabels, useT } from '@/lib/i18n';
import { newUuid, saleCode } from '@/lib/uuid';
import { selectLines, selectTotal, useCartStore } from '@/stores/cart';
import type { CartLine } from '@/stores/cart';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { LineThumb } from '../checkout/LineThumb';
import { computeChange, quickCashOptions } from './change';
import { payStrings } from './strings';
import { buildVietQr } from './vietqr';

/** How long the green "received" state shows before returning to the camera. */
export const SUCCESS_MS = 700;
const QR_SIZE = 225;

const groupAccount = (account: string) =>
  account.length > 4
    ? `${account.slice(0, 4)} ${account.slice(4).replace(/(\d{3})(?=\d)/g, '$1 ')}`
    : account;

const OrderItem = memo(function OrderItem({ line }: { line: CartLine }) {
  return (
    <View style={styles.item}>
      <View>
        <LineThumb uri={line.imageUrl} />
        {line.qty > 1 ? (
          <Text
            style={styles.qtyBadge}
            accessibilityLabel={`Số lượng ${line.qty}`}
          >
            {line.qty}
          </Text>
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.itemPrice}>
        {formatVnd(line.price * line.qty).replace('đ', '')}
      </Text>
    </View>
  );
});

type CashChipProps = {
  amount: number;
  exact: boolean;
  pressed: boolean;
  onPick: (amount: number) => void;
};

const CashChip = memo(function CashChip({
  amount,
  exact,
  pressed,
  onPick,
}: CashChipProps) {
  const pick = useCallback(() => onPick(amount), [onPick, amount]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={exact ? 'Đủ tiền' : undefined}
      accessibilityState={{ selected: pressed }}
      aria-selected={pressed}
      onPress={pick}
      style={[styles.chip, pressed && styles.chipOn]}
    >
      <Text style={[styles.chipText, pressed && styles.chipTextOn]}>
        {formatVnd(amount).replace('đ', '')}
      </Text>
    </PressableScale>
  );
});

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
  const clearCart = useCartStore((s) => s.clear);
  const store = useStore();
  const sale = useCreateSale();

  const t = useT(debtStrings);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [picker, setPicker] = useState(false);
  const [paidText, setPaidText] = useState('0');
  const paidNow = Number(paidText || '0');
  const invalidPaid =
    !/^\d*$/.test(paidText) ||
    !Number.isSafeInteger(paidNow) ||
    paidNow > total;
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [tendered, setTendered] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [saleId] = useState(newUuid);
  const lineIds = useRef(new Map<string, string>()).current;
  // The device time of the first "Đã nhận": a retry must resend it, or the server sees another body.
  const soldAt = useRef<string | null>(null);
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
  const change = computeChange(total, cashGiven);
  const options = useMemo(() => quickCashOptions(total), [total]);
  const short = method === 'cash' && cashGiven < total;

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

  const received = useCallback(() => {
    const scanIds = [
      ...new Set(lines.flatMap((l) => (l.scanId ? [l.scanId] : []))),
    ];
    const body: CreateSaleRequest = {
      id: saleId,
      sold_at: (soldAt.current ??= new Date().toISOString()),
      payment_method:
        method === 'credit' ? (paidNow === 0 ? 'credit' : 'cash') : method,
      ...(method === 'credit' && customer && paidNow < total
        ? { credit: { customer_id: customer.id, amount: total - paidNow } }
        : {}),
      total,
      ...(method === 'credit'
        ? paidNow > 0
          ? { cash_received: paidNow }
          : {}
        : method === 'cash'
          ? { cash_received: cashGiven }
          : { vietqr_memo: memo }),
      lines: lines.map((line) => {
        let id = lineIds.get(line.productId);
        if (!id) {
          id = newUuid();
          lineIds.set(line.productId, id);
        }
        return {
          id,
          product_id: line.productId,
          source: line.manual ? 'manual' : (line.source ?? 'camera'),
          quantity: line.qty,
          unit_price: line.price,
          ...(line.manual ? { manual_label: line.name.slice(0, 80) } : {}),
          ...(line.detectionId ? { detection_id: line.detectionId } : {}),
          ...(line.suggestedProductId
            ? { suggested_product_id: line.suggestedProductId }
            : {}),
        };
      }),
      ...(scanIds.length > 0 ? { scan_ids: scanIds } : {}),
    };
    sale.mutate(body, {
      onSuccess: () => {
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        clearCart();
        setDone(true);
      },
    });
  }, [
    saleId,
    method,
    total,
    cashGiven,
    memo,
    lines,
    lineIds,
    sale,
    clearCart,
    customer,
    paidNow,
  ]);

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
        <PayToggle
          value={method}
          onChange={(next) => {
            setMethod(next);
            if (next === 'credit' && !customer) setPicker(true);
          }}
          labels={toggle}
        />
      </View>

      <MoneyText amount={total} variant="total" style={styles.total} />

      {method === 'credit' ? (
        <View style={styles.cashCard}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={customer ? t('change') : t('choose')}
            onPress={() => setPicker(true)}
            style={styles.retry}
          >
            <Text style={styles.retryText}>
              {customer ? `${customer.name} · ${t('change')}` : t('choose')}
            </Text>
          </PressableScale>
          <Text>{t('paidNow')}</Text>
          <TextInput
            accessibilityLabel={t('paidNow')}
            value={paidText}
            onChangeText={setPaidText}
            keyboardType="number-pad"
            style={styles.paidInput}
          />
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
      ) : method === 'transfer' ? (
        <View style={styles.qrCard}>
          {store.isPending ? (
            <ActivityIndicator
              accessibilityLabel="Đang tải"
              color={colors.ink}
              size="large"
            />
          ) : store.isError ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                Không tải được tài khoản ngân hàng
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Thử lại"
                onPress={retryStore}
                style={styles.retry}
              >
                <Text style={styles.retryText}>Thử lại</Text>
              </PressableScale>
            </View>
          ) : payload && bank ? (
            <>
              <View
                accessible
                accessibilityRole="image"
                accessibilityLabel={`Mã VietQR ${formatVnd(total)}`}
                style={styles.qrFrame}
              >
                <QRCode value={payload} size={QR_SIZE} />
              </View>
              <View
                accessible
                accessibilityLabel={`${bank.account_name}, ${bank.bank_short_name ?? bank.bank_bin} ${groupAccount(bank.account_number)}`}
                style={styles.bankRow}
              >
                <Icon icon={Landmark} size={20} color={colors.inkMuted} />
                <Text style={styles.bankText} numberOfLines={1}>
                  {`${bank.bank_short_name ?? bank.bank_bin} · ${groupAccount(bank.account_number)}`}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>Chưa có tài khoản ngân hàng</Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Thêm tài khoản ngân hàng"
                onPress={addBank}
                style={styles.retry}
              >
                <Text style={styles.retryText}>Thêm tài khoản</Text>
              </PressableScale>
            </View>
          )}
        </View>
      ) : (
        <View style={styles.cashCard}>
          <View style={styles.chips}>
            {options.map((amount) => (
              <CashChip
                key={amount}
                amount={amount}
                exact={amount === total}
                pressed={amount === cashGiven}
                onPick={setTendered}
              />
            ))}
          </View>
          <View style={styles.changeRow}>
            <Icon icon={Undo2} color={colors.inkMuted} />
            <Text accessibilityLabel="Tiền thối" style={styles.change}>
              {formatVnd(change)}
            </Text>
          </View>
        </View>
      )}

      <ScrollView
        accessibilityLabel="Món trong đơn"
        style={styles.items}
        contentContainerStyle={styles.itemsContent}
      >
        {lines.map((line) => (
          <OrderItem key={line.productId} line={line} />
        ))}
      </ScrollView>

      {sale.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Không lưu được đơn. Giỏ hàng vẫn còn, thử lại.
        </Text>
      ) : null}
      <CheckButton
        variant="success"
        accessibilityLabel="Đã nhận tiền"
        onPress={received}
        disabled={
          sale.isPending ||
          done ||
          lines.length === 0 ||
          short ||
          (method === 'credit' && (!customer || invalidPaid)) ||
          picker
        }
        block
        xl
      />

      {picker ? (
        <CustomerPicker
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

const styles = StyleSheet.create({
  paidInput: {
    ...typography.body,
    color: colors.ink,
    minHeight: 48,
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  screen: {
    flex: 1,
    paddingHorizontal: space[4],
    gap: space[4],
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  total: { textAlign: 'center' },
  qrCard: {
    alignItems: 'center',
    gap: space[3],
    paddingTop: 20,
    paddingHorizontal: space[4],
    paddingBottom: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  qrFrame: {
    padding: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  bankRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  bankText: {
    ...typography.caption,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  notice: { alignItems: 'center', gap: space[3], paddingVertical: space[6] },
  noticeText: {
    ...typography.body,
    color: colors.inkMuted,
    textAlign: 'center',
    paddingVertical: space[6],
  },
  retry: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  retryText: { ...typography.label, color: colors.onInk },
  cashCard: {
    gap: space[3],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  chip: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.ink },
  chipText: {
    fontFamily: fontFamily.semibold,
    fontSize: 20,
    lineHeight: 26,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  chipTextOn: { color: colors.onInk },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    paddingTop: space[4],
    paddingBottom: space[2],
  },
  change: {
    fontFamily: fontFamily.extrabold,
    fontSize: 40,
    lineHeight: 46,
    color: colors.success,
    fontVariant: ['tabular-nums'],
  },
  items: { flex: 1 },
  itemsContent: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space[2] },
  item: { width: '25%', alignItems: 'center', gap: space[1] },
  qtyBadge: {
    position: 'absolute',
    right: -6,
    top: -6,
    width: 24,
    height: 24,
    borderRadius: radius.full,
    overflow: 'hidden',
    textAlign: 'center',
    fontFamily: fontFamily.bold,
    fontSize: 13,
    lineHeight: 24,
    color: colors.onInk,
    backgroundColor: colors.ink,
  },
  itemPrice: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  error: { ...typography.label, color: colors.danger, textAlign: 'center' },
  success: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.successSoft,
  },
  successDisc: {
    width: 128,
    height: 128,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.success,
  },
});
