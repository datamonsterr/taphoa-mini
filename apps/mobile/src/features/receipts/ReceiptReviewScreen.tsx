import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ArrowLeft, Trash2, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, PressableScale, Text } from '@/components/ui';
import {
  useConfirmReceipt,
  useDiscardReceipt,
  useProduct,
  useReceipt,
  type Receipt,
  type ReceiptConfirm,
  type ReceiptLine,
} from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { businessDate } from '@/lib/date';
import { colors, fontFamily, radius, space, typography } from '@/theme';
import { ProductPicker } from './ProductPicker';
import { useReceiptNotice } from './ReceiptToast';
import { strings } from './strings';

const back = () => {
  if (router.canGoBack()) router.back();
  else router.dismissTo('/');
};

type EditableLine = {
  line: ReceiptLine;
  quantity: string;
  cost: string;
  productId: string | null;
};
const integer = (text: string) =>
  /^\d+$/.test(text) && Number.isSafeInteger(Number(text));
const valid = (l: EditableLine) =>
  l.productId !== null &&
  integer(l.quantity) &&
  Number(l.quantity) > 0 &&
  Number(l.quantity) <= 2147483647 &&
  integer(l.cost);

export function ReceiptReviewScreen({ id }: { id: string }) {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const receipt = useReceipt(id);
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.header}>
        <CircleButton
          icon={ArrowLeft}
          accessibilityLabel={t('back')}
          onPress={back}
        />
        <Text accessibilityRole="header" style={typography.heading}>
          {t('review')}
        </Text>
      </View>
      {receipt.isPending ? (
        <ActivityIndicator accessibilityLabel={t('loading')} />
      ) : receipt.data ? (
        <Review
          key={receipt.data.id + receipt.data.status}
          receipt={receipt.data}
        />
      ) : (
        <View style={styles.content}>
          <Text accessibilityRole="alert">{t('error')}</Text>
          <Action label={t('retry')} onPress={() => void receipt.refetch()} />
        </View>
      )}
    </View>
  );
}

function ProductChip({
  line,
  productId,
  readonly,
  onPress,
}: {
  line: ReceiptLine;
  productId: string | null;
  readonly: boolean;
  onPress: () => void;
}) {
  const t = useT(strings);
  const product = useProduct(productId ?? undefined);
  const name =
    product.data?.name ??
    line.candidates.find((c) => c.product_id === productId)?.name ??
    t('unnamed');
  const label = productId ? name : t('unmatched');
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${line.product_name}`}
      disabled={readonly}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: productId ? colors.successSoft : colors.warningSoft,
        },
      ]}
    >
      <Text
        style={[
          typography.label,
          { color: productId ? colors.success : colors.warning },
        ]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

function Review({ receipt }: { receipt: Receipt }) {
  const t = useT(strings);
  const [lines, setLines] = useState<EditableLine[]>(() =>
    receipt.lines.map((line) => ({
      line,
      quantity: String(line.quantity),
      cost: String(line.cost),
      productId: line.product_id,
    })),
  );
  const [paidWith, setPaidWith] =
    useState<ReceiptConfirm['paid_with']>('cash_box');
  const [picker, setPicker] = useState<string | null>(null);
  const [photo, setPhoto] = useState(false);
  const [error, setError] = useState(false);
  const confirm = useConfirmReceipt(receipt.id);
  const discard = useDiscardReceipt(receipt.id);
  const busyRef = useRef(false);
  // An unchanged retry replays exactly the same confirmation after a lost response.
  const request = useRef<ReceiptConfirm | null>(null);
  const readonly = receipt.status !== 'draft';
  const busy = confirm.isPending || discard.isPending;
  const total = readonly
    ? receipt.total
    : lines.reduce((sum, l) => sum + (integer(l.cost) ? Number(l.cost) : 0), 0);
  const canConfirm =
    lines.length > 0 &&
    lines.every(valid) &&
    Number.isSafeInteger(total) &&
    !busy;
  const change = (id: string, patch: Partial<EditableLine>) =>
    setLines((ls) =>
      ls.map((l) => (l.line.id === id ? { ...l, ...patch } : l)),
    );
  const save = async () => {
    if (!canConfirm || busyRef.current) return;
    busyRef.current = true;
    setError(false);
    const body: ReceiptConfirm = {
      lines: lines.map((l) => ({
        line_id: l.line.id,
        product_id: l.productId!,
        quantity: Number(l.quantity),
        cost: Number(l.cost),
      })),
      paid_with: paidWith,
    };
    if (JSON.stringify(request.current) !== JSON.stringify(body))
      request.current = body;
    try {
      const saved = await confirm.mutateAsync(request.current!);
      useReceiptNotice.setState({ count: saved.lines.length });
      router.dismissTo('/');
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
    }
  };
  const discardConfirmed = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(false);
    try {
      await discard.mutateAsync();
      router.dismissTo('/');
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
    }
  };
  const discardDraft = () => {
    if (Platform.OS === 'web') {
      if (window.confirm(t('discardPrompt'))) void discardConfirmed();
    } else {
      Alert.alert(t('discardPrompt'), t('discardMessage'), [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('discard'),
          style: 'destructive',
          onPress: () => void discardConfirmed(),
        },
      ]);
    }
  };
  const chosenLine = lines.find((l) => l.line.id === picker);
  return (
    <>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('photo')}
            onPress={() => setPhoto(true)}
          >
            <Image
              source={{ uri: receipt.image_url }}
              style={styles.thumbnail}
              contentFit="cover"
            />
          </PressableScale>
          <View style={styles.grow}>
            <Text style={typography.label}>
              {businessDate(receipt.created_at)}
            </Text>
            <Text style={typography.caption}>{t(receipt.status)}</Text>
          </View>
          {!readonly ? (
            <CircleButton
              icon={Trash2}
              accessibilityLabel={t('discard')}
              onPress={discardDraft}
              disabled={busy}
            />
          ) : null}
        </View>
        {lines.map((l) => (
          <View key={l.line.id} style={styles.line}>
            <Text style={typography.label}>{l.line.product_name}</Text>
            <View style={styles.fields}>
              <View style={styles.grow}>
                <Text style={typography.caption}>{t('quantity')}</Text>
                {readonly ? (
                  <Text style={typography.body}>{l.quantity}</Text>
                ) : (
                  <TextInput
                    accessibilityLabel={`${t('quantity')}: ${l.line.product_name}`}
                    value={l.quantity}
                    onChangeText={(quantity) => change(l.line.id, { quantity })}
                    keyboardType="number-pad"
                    editable={!busy}
                    style={styles.input}
                    maxLength={10}
                  />
                )}
              </View>
              <View style={styles.amountField}>
                <Text style={typography.caption}>{t('cost')}</Text>
                {readonly ? (
                  <Text style={typography.body}>
                    {formatVnd(Number(l.cost))}
                  </Text>
                ) : (
                  <TextInput
                    accessibilityLabel={`${t('cost')}: ${l.line.product_name}`}
                    value={
                      l.cost === ''
                        ? ''
                        : integer(l.cost)
                          ? formatVnd(Number(l.cost))
                          : l.cost
                    }
                    onChangeText={(text) =>
                      change(l.line.id, { cost: text.replace(/[.đ\s]/g, '') })
                    }
                    keyboardType="number-pad"
                    editable={!busy}
                    style={styles.input}
                  />
                )}
              </View>
            </View>
            <View style={styles.fields}>
              <View style={styles.grow}>
                <ProductChip
                  line={l.line}
                  productId={l.productId}
                  readonly={readonly || busy}
                  onPress={() => setPicker(l.line.id)}
                />
              </View>
              {!readonly ? (
                <CircleButton
                  icon={Trash2}
                  accessibilityLabel={`${t('drop')} ${l.line.product_name}`}
                  disabled={busy}
                  onPress={() =>
                    setLines((ls) => ls.filter((x) => x.line.id !== l.line.id))
                  }
                />
              ) : null}
            </View>
          </View>
        ))}
        {readonly && receipt.expense_id ? (
          <Text
            accessibilityLabel={t('linkedExpense')}
            style={typography.heading}
          >
            {t('linkedExpense')}: {formatVnd(receipt.total)}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <Text
          accessibilityLabel={t('total')}
          accessibilityLiveRegion="polite"
          style={typography.price}
        >
          {formatVnd(total)}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('saveError')}
          </Text>
        ) : null}
        {!readonly ? (
          <>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={t('payment')}
              style={styles.fields}
            >
              {(['cash_box', 'other'] as const).map((value) => (
                <PressableScale
                  key={value}
                  accessibilityRole="radio"
                  accessibilityLabel={t(value)}
                  accessibilityState={{
                    checked: paidWith === value,
                    disabled: busy,
                  }}
                  disabled={busy}
                  onPress={() => setPaidWith(value)}
                  style={[styles.toggle, paidWith === value && styles.toggleOn]}
                >
                  <Text
                    style={[
                      typography.label,
                      { color: paidWith === value ? colors.onInk : colors.ink },
                    ]}
                  >
                    {t(value)}
                  </Text>
                </PressableScale>
              ))}
            </View>
            <Action
              label={t('confirm')}
              disabled={!canConfirm}
              onPress={() => void save()}
            />
            {busy ? (
              <ActivityIndicator accessibilityLabel={t('saving')} />
            ) : null}
          </>
        ) : null}
      </View>
      {chosenLine ? (
        <ProductPicker
          line={chosenLine.line}
          onClose={() => setPicker(null)}
          onChoose={(productId) => {
            change(chosenLine.line.id, { productId });
            setPicker(null);
          }}
        />
      ) : null}
      <Modal
        visible={photo}
        transparent
        animationType="fade"
        onRequestClose={() => setPhoto(false)}
      >
        <View style={styles.photo}>
          <Image
            testID="receipt-full-photo"
            source={{ uri: receipt.image_url }}
            contentFit="contain"
            style={styles.fullPhoto}
          />
          <CircleButton
            icon={X}
            accessibilityLabel={t('closePhoto')}
            onPress={() => setPhoto(false)}
          />
        </View>
      </Modal>
    </>
  );
}

export function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
  },
  content: { padding: space[4], gap: space[4] },
  grow: { flex: 1 },
  thumbnail: {
    width: 72,
    height: 88,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  line: {
    gap: space[3],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  fields: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  amountField: { flex: 2 },
  input: {
    minHeight: 56,
    padding: space[3],
    backgroundColor: colors.surface,
    color: colors.ink,
    borderRadius: radius.sm,
    fontFamily: fontFamily.semibold,
    fontSize: 18,
  },
  chip: {
    minHeight: 56,
    justifyContent: 'center',
    padding: space[3],
    borderRadius: radius.full,
  },
  footer: {
    padding: space[4],
    gap: space[3],
    borderTopWidth: 1,
    borderTopColor: colors.surfacePressed,
  },
  toggle: {
    flex: 1,
    minHeight: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSoft,
  },
  toggleOn: { backgroundColor: colors.ink },
  action: {
    minHeight: 56,
    padding: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { ...typography.label, color: colors.onInk },
  disabled: { opacity: 0.4 },
  error: { ...typography.caption, color: colors.danger },
  photo: {
    flex: 1,
    padding: space[8],
    paddingTop: 64,
    paddingBottom: 64,
    alignItems: 'center',
    gap: space[4],
    backgroundColor: colors.cameraBg,
  },
  fullPhoto: { flex: 1, width: '100%' },
});
