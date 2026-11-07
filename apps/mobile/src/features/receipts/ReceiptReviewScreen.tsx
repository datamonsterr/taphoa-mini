import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
  ArrowLeft,
  Banknote,
  Check,
  ChevronRight,
  MessageCircleText,
  Plus,
  QrCode,
  ReceiptText,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react-native';
import { onlineManager } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import { useAssistantEnabled } from '@/features/assistant/flags';
import { assistantHref } from '@/features/assistant/route';
import { formatDayMonth } from '@/features/digest/utils';
import {
  useConfirmReceipt,
  useDiscardReceipt,
  useProduct,
  isApiError,
  useReceipt,
  type Receipt,
  type ReceiptConfirm,
  type ReceiptLine,
} from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { businessDate } from '@/lib/date';
import { camera, colors, fontFamily, radius, space, typography } from '@/theme';
import { ProductPicker } from './ProductPicker';
import { ReceiptLineStatus, receiptLineStatus } from './ReceiptLineStatus';
import { ReceiptPriceKeypad, ReceiptPricePill } from './ReceiptPrice';
import { ReceiptQuantityStepper } from './ReceiptQuantityStepper';
import { ReceiptSummaryLine } from './ReceiptSummaryLine';
import { useReceiptNotice } from './ReceiptToast';
import { strings } from './strings';

const back = () => {
  if (router.canGoBack()) router.back();
  else router.dismissTo('/');
};

type EditableLine = {
  key: string;
  line?: ReceiptLine;
  name: string;
  quantity: number;
  unitPrice: number;
  productId: string | null;
};
// The API stores line amounts. Preserve their precision when deriving a unit price,
// and round the derived amount once to whole đồng for confirmation.
/** A request that failed while the phone is offline says so instead of "try again". */
const failureKind = (): 'save' | 'offline' =>
  onlineManager.isOnline() ? 'save' : 'offline';
const lineTotal = (line: EditableLine) =>
  Math.round(line.quantity * line.unitPrice);
const valid = (line: EditableLine) =>
  line.productId !== null &&
  Number.isInteger(line.quantity) &&
  line.quantity >= 1 &&
  line.quantity <= 2147483647 &&
  Number.isFinite(line.unitPrice) &&
  line.unitPrice >= 0 &&
  Number.isSafeInteger(lineTotal(line));

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
      {receipt.data ? (
        <Review
          key={receipt.data.id + receipt.data.status}
          receipt={receipt.data}
        />
      ) : (
        <>
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
          ) : (
            <View style={styles.content}>
              {isApiError(receipt.error) && receipt.error.status === 404 ? (
                <>
                  <Text accessibilityRole="alert">{t('notFound')}</Text>
                  <Action label={t('toList')} onPress={back} />
                </>
              ) : (
                <>
                  <Text accessibilityRole="alert">{t('error')}</Text>
                  <Action
                    label={t('retry')}
                    onPress={() => void receipt.refetch()}
                  />
                </>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ProductChip({
  line,
  readonly,
  disabled,
  onPress,
}: {
  line: EditableLine;
  readonly: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useT(strings);
  const product = useProduct(line.productId ?? undefined);
  const name =
    product.data?.name ??
    line.line?.candidates.find((c) => c.product_id === line.productId)?.name ??
    line.name;
  if (readonly) return <Text style={typography.label}>{name}</Text>;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${t('changeProduct')}`}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={styles.product}
    >
      <Text numberOfLines={1} style={[styles.name, styles.grow]}>
        {name}
      </Text>
      <Icon icon={ChevronRight} size={20} color={colors.inkMuted} />
    </PressableScale>
  );
}

function Review({ receipt }: { receipt: Receipt }) {
  const t = useT(strings);
  const [lines, setLines] = useState<EditableLine[]>(() =>
    receipt.lines.map((line) => ({
      key: line.id,
      line,
      name: line.product_name,
      quantity: Math.max(1, line.quantity),
      unitPrice: (line.cost ?? 0) / Math.max(1, line.quantity),
      productId: line.product_id,
    })),
  );
  const [paidWith, setPaidWith] =
    useState<ReceiptConfirm['paid_with']>('cash_box');
  const [picker, setPicker] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [summary, setSummary] = useState(receipt.status !== 'draft');
  const [photo, setPhoto] = useState(false);
  const [error, setError] = useState<'save' | 'offline' | null>(null);
  const confirm = useConfirmReceipt(receipt.id);
  const discard = useDiscardReceipt(receipt.id);
  const busyRef = useRef(false);
  const newLineNumber = useRef(0);
  // An unchanged retry replays exactly the same confirmation after a lost response.
  const request = useRef<ReceiptConfirm | null>(null);
  const readonly = receipt.status !== 'draft';
  const busy = confirm.isPending || discard.isPending;
  const total = readonly
    ? receipt.total
    : lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const fixes = lines.filter(
    (line) => receiptLineStatus(line.productId, line.unitPrice) !== 'matched',
  ).length;
  const missing = lines.filter((line) => !line.productId);
  const canConfirm =
    lines.length > 0 &&
    lines.length <= 100 &&
    lines.every(valid) &&
    Number.isSafeInteger(total) &&
    total > 0 &&
    !busy;
  const change = (key: string, patch: Partial<EditableLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const save = async () => {
    if (!canConfirm || busyRef.current) return;
    setError(null);
    // Offline the request would only wait: say so at once and keep the draft as it is.
    if (!onlineManager.isOnline()) {
      setError('offline');
      return;
    }
    busyRef.current = true;
    const body: ReceiptConfirm = {
      lines: lines.map((line) => ({
        ...(line.line ? { line_id: line.line.id } : {}),
        product_id: line.productId!,
        quantity: line.quantity,
        cost: lineTotal(line),
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
      setError(failureKind());
    } finally {
      busyRef.current = false;
    }
  };
  const discardConfirmed = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    try {
      await discard.mutateAsync();
      router.dismissTo('/');
    } catch {
      setError(failureKind());
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
  const assistant = useAssistantEnabled() && !readonly;
  const chosenLine = lines.find((line) => line.key === picker);
  const priceLine = lines.find((line) => line.key === editingPrice);
  return (
    <>
      <View style={styles.header}>
        <CircleButton
          icon={ArrowLeft}
          accessibilityLabel={t('back')}
          disabled={busy}
          onPress={() => {
            if (summary && !readonly) setSummary(false);
            else if (editingPrice) setEditingPrice(null);
            else back();
          }}
        />
        <View style={styles.grow}>
          <Text accessibilityRole="header" style={typography.heading}>
            {t(summary ? 'title' : 'review')}
          </Text>
          <Text accessibilityLiveRegion="polite" style={styles.meta}>
            {summary
              ? `${formatDayMonth(businessDate(receipt.created_at))} · ${t(receipt.status).toLocaleLowerCase()}`
              : fill(t('fixCount'), { count: lines.length, fixes })}
          </Text>
        </View>
        {assistant ? (
          <CircleButton
            icon={MessageCircleText}
            accessibilityLabel={t(
              summary ? 'assistantSummary' : 'assistantEdit',
            )}
            disabled={busy}
            onPress={() =>
              router.push(
                assistantHref({
                  entry: 'receipt',
                  screen: 'receipt',
                  receiptId: receipt.id,
                }),
              )
            }
          />
        ) : null}
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('photo')}
          onPress={() => setPhoto(true)}
          style={[styles.photoStrip, summary && styles.summaryPhoto]}
        >
          {summary ? (
            <Icon icon={ReceiptText} color={colors.cameraMuted} />
          ) : (
            <Image
              source={{ uri: receipt.image_url }}
              style={styles.thumbnail}
              contentFit="cover"
            />
          )}
          <Text
            numberOfLines={1}
            style={[styles.photoLabel, summary && styles.photoLabelCentre]}
          >
            {t('photo')}
          </Text>
          {summary ? null : <Icon icon={ZoomIn} color={colors.cameraMuted} />}
        </PressableScale>
        {lines.map((line, index) =>
          summary ? (
            <ReceiptSummaryLine
              key={line.key}
              line={line}
              total={lineTotal(line)}
              readonly={readonly}
              disabled={busy}
              first={index === 0}
              onPick={() => setPicker(line.key)}
            />
          ) : (
            <View
              key={line.key}
              style={[styles.line, !line.productId && styles.unmatched]}
            >
              <View style={styles.fields}>
                <View style={styles.grow}>
                  <ProductChip
                    line={line}
                    readonly={readonly}
                    disabled={busy}
                    onPress={() => setPicker(line.key)}
                  />
                </View>
                <ReceiptLineStatus
                  productId={line.productId}
                  price={line.unitPrice}
                />
                {!readonly ? (
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`${t('drop')} ${line.name}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    hitSlop={10}
                    onPress={() => {
                      setLines((current) =>
                        current.filter((l) => l.key !== line.key),
                      );
                      if (editingPrice === line.key) setEditingPrice(null);
                    }}
                    style={styles.drop}
                  >
                    <Icon icon={Trash2} size={20} color={colors.inkMuted} />
                  </PressableScale>
                ) : null}
              </View>
              {line.line?.raw_text ? (
                <Text style={styles.meta}>
                  {fill(t('source'), { text: line.line.raw_text })}
                </Text>
              ) : null}
              <View style={styles.amounts}>
                <ReceiptQuantityStepper
                  name={line.name}
                  value={line.quantity}
                  disabled={busy}
                  onChange={(quantity) => change(line.key, { quantity })}
                />
                <Text style={styles.meta}>×</Text>
                <ReceiptPricePill
                  name={line.name}
                  price={line.unitPrice}
                  disabled={busy}
                  editing={editingPrice === line.key}
                  onPress={() => setEditingPrice(line.key)}
                />
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  accessibilityLabel={`${t('cost')}: ${line.name}`}
                  style={styles.lineTotal}
                >
                  {formatVnd(lineTotal(line))}
                </Text>
              </View>
            </View>
          ),
        )}
        {!readonly && !summary ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('addLine')}
            accessibilityState={{ disabled: busy || lines.length >= 100 }}
            disabled={busy || lines.length >= 100}
            style={styles.addLine}
            onPress={() => {
              const number = ++newLineNumber.current;
              setLines((current) => [
                ...current,
                {
                  key: `new-${number}`,
                  name: fill(t('newLine'), { number }),
                  quantity: 1,
                  unitPrice: 0,
                  productId: null,
                },
              ]);
            }}
          >
            <Icon icon={Plus} />
            <Text style={typography.label}>{t('addLine')}</Text>
          </PressableScale>
        ) : null}
        {!readonly && receipt.parser === 'fallback' ? (
          <Text accessibilityRole="alert" style={styles.notice}>
            {t('fallbackNotice')}
          </Text>
        ) : null}
        {summary && !readonly && missing.length === 0 && total <= 0 ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t('zeroTotal')}
          </Text>
        ) : null}
        {summary && missing.length > 0 && !readonly ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {fill(t('missingProducts'), {
              lines: missing.map((line) => line.name).join(', '),
            })}
          </Text>
        ) : null}
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
        {!summary && priceLine ? (
          <ReceiptPriceKeypad
            key={priceLine.key}
            name={priceLine.name}
            price={priceLine.unitPrice}
            onChange={(unitPrice) => change(priceLine.key, { unitPrice })}
            onDone={() => setEditingPrice(null)}
          />
        ) : (
          <>
            <View style={styles.fields}>
              <Text style={[typography.label, styles.grow]}>
                {summary ? t('total') : fill(t('itemTotal'), { count })}
              </Text>
              <Text
                accessibilityLabel={t('total')}
                accessibilityLiveRegion="polite"
                style={styles.total}
              >
                {formatVnd(total)}
              </Text>
            </View>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {t(error === 'offline' ? 'offlineError' : 'saveError')}
              </Text>
            ) : null}
            {!readonly && !summary ? (
              <Action
                label={t('reviewDone')}
                check
                disabled={busy || lines.length === 0}
                onPress={() => setSummary(true)}
              />
            ) : !readonly ? (
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
                      style={[
                        styles.toggle,
                        paidWith === value && styles.toggleOn,
                      ]}
                    >
                      <Icon
                        icon={value === 'cash_box' ? Banknote : QrCode}
                        color={paidWith === value ? colors.onInk : colors.ink}
                      />
                    </PressableScale>
                  ))}
                  <Text style={[styles.meta, styles.grow]}>
                    {t('expenseHint')}
                  </Text>
                </View>
                <Action
                  label={t('confirm')}
                  success
                  disabled={!canConfirm}
                  onPress={() => void save()}
                />
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('discard')}
                  disabled={busy}
                  onPress={discardDraft}
                  style={styles.discard}
                >
                  <Text style={styles.error}>{t('discard')}</Text>
                </PressableScale>
                {busy ? (
                  <ActivityIndicator accessibilityLabel={t('saving')} />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </View>
      {chosenLine ? (
        <ProductPicker
          line={chosenLine.line ?? { candidates: [] }}
          onClose={() => setPicker(null)}
          onChoose={(productId) => {
            change(chosenLine.key, { productId });
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
  success = false,
  check = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  success?: boolean;
  check?: boolean;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        success && styles.success,
        disabled && styles.disabled,
      ]}
    >
      {success || check ? <Icon icon={Check} color={colors.onInk} /> : null}
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
    padding: space[4],
  },
  content: {
    paddingHorizontal: space[4],
    paddingBottom: space[4],
    gap: space[2],
  },
  grow: { flex: 1, minWidth: 0 },
  name: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 },
  meta: { ...typography.caption, color: colors.inkMuted },
  thumbnail: {
    width: 32,
    height: 44,
    borderRadius: space[1],
    backgroundColor: colors.surfaceSoft,
  },
  photoStrip: {
    minHeight: 64,
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    backgroundColor: camera.viewfinderBg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  summaryPhoto: { minHeight: 96, justifyContent: 'center' },
  photoLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 15,
    lineHeight: 20,
    color: colors.cameraMuted,
    flex: 1,
  },
  photoLabelCentre: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  line: {
    gap: space[2],
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  unmatched: { backgroundColor: colors.warningSoft },
  product: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  fields: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  // Board 19b: stepper, ×, unit price and line total share one row.
  amounts: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  lineTotal: {
    fontFamily: fontFamily.extrabold,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'right',
    flex: 1,
    flexShrink: 0,
    minWidth: 0,
    fontVariant: ['tabular-nums'],
  },
  drop: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  addLine: {
    minHeight: 56,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  footer: { padding: space[4], gap: space[3] },
  total: {
    fontFamily: fontFamily.extrabold,
    fontSize: 28,
    lineHeight: 32,
    fontVariant: ['tabular-nums'],
  },
  toggle: {
    minWidth: 72,
    minHeight: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSoft,
  },
  toggleOn: { backgroundColor: colors.ink },
  action: {
    flexDirection: 'row',
    gap: space[2],
    minHeight: 64,
    padding: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  success: { backgroundColor: colors.success },
  actionText: { ...typography.label, color: colors.onInk },
  disabled: { opacity: 0.4 },
  error: { ...typography.caption, color: colors.danger },
  notice: { ...typography.caption, color: colors.warning },
  discard: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
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
