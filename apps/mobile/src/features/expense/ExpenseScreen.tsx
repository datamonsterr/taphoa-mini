import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
  Box,
  Droplet,
  Ellipsis,
  ReceiptText,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { memo, useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  applyKey,
  CheckButton,
  CircleButton,
  Icon,
  Keypad,
  PressableScale,
  useKeypadDiameter,
  Sheet,
  type KeypadKeyId,
  Text,
} from '@/components/ui';
import { useCreateExpense, useUploadImage } from '@/lib/api';
import type { ExpenseCategory } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useLabels, useT } from '@/lib/i18n';
import { newUuid } from '@/lib/uuid';
import { selectCanEnroll, useSessionStore } from '@/stores/session';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { dismissSheet } from '../dashboard/dismiss';
import { BillCamera } from './BillCamera';
import { expenseStrings } from './strings';

/** Sheet height on the Expense board. */
const SHEET_HEIGHT = 748;
const MAX_DIGITS = 10;

const CATEGORIES: readonly { id: ExpenseCategory; icon: LucideIcon }[] = [
  { id: 'nhap_hang', icon: Box },
  { id: 'dien', icon: Zap },
  { id: 'nuoc', icon: Droplet },
  { id: 'khac', icon: Ellipsis },
];

const keypadLabels = (t: (key: string) => string) => ({
  delete: t('keypad.delete'),
});

export function ExpenseScreen() {
  const t = useT(expenseStrings);
  const canEnroll = useSessionStore(selectCanEnroll);
  const padLabels = useLabels(expenseStrings, keypadLabels);
  const keyDiameter = useKeypadDiameter(76);
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [digits, setDigits] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [failed, setFailed] = useState(false);
  // One id per open sheet: a retry after a network error must not book the expense twice.
  const expenseId = useRef(newUuid()).current;
  // Fixed at the first save, so the retry is the same request and the server replays it.
  const spentAt = useRef<string | null>(null);
  const upload = useUploadImage();
  const create = useCreateExpense();
  const { mutateAsync: uploadAsync } = upload;
  const { mutateAsync: createAsync } = create;

  const amount = Number(digits);
  const saving = upload.isPending || create.isPending;
  const canSave = amount > 0 && category !== null && !saving;

  const onKey = useCallback(
    (key: KeypadKeyId) =>
      setDigits((value) => applyKey(value, key, MAX_DIGITS)),
    [],
  );
  const openCamera = useCallback(() => setShooting(true), []);
  const closeCamera = useCallback(() => setShooting(false), []);
  const acceptPhoto = useCallback((uri: string) => {
    setPhotoUri(uri);
    setShooting(false);
  }, []);

  const save = useCallback(async () => {
    if (!category || amount <= 0) return;
    setFailed(false);
    try {
      const image = photoUri
        ? await uploadAsync({
            file: { uri: photoUri, name: 'bill.jpg', type: 'image/jpeg' },
            purpose: 'expense_receipt',
          })
        : null;
      await createAsync({
        id: expenseId,
        spent_at: (spentAt.current ??= new Date().toISOString()),
        amount,
        category,
        paid_with: 'cash_box',
        ...(image ? { image_id: image.id } : {}),
      });
    } catch {
      setFailed(true);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    dismissSheet();
  }, [amount, category, photoUri, expenseId, uploadAsync, createAsync]);

  return (
    <View style={styles.root}>
      <Sheet
        height={SHEET_HEIGHT}
        onClose={dismissSheet}
        footer={
          <View style={styles.footer}>
            {failed ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {t('saveError')}
              </Text>
            ) : null}
            <CheckButton
              variant="ink"
              block
              accessibilityLabel={t('save')}
              disabled={!canSave}
              onPress={save}
            />
          </View>
        }
      >
        <View style={styles.body}>
          <Text accessibilityRole="header" style={styles.srOnly}>
            {t('screen')}
          </Text>
          <View style={styles.topRow}>
            <CircleButton
              icon={X}
              accessibilityLabel={t('close')}
              onPress={dismissSheet}
              testID="expense-close"
            />
            {photoUri ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('billPhoto')}
                onPress={openCamera}
                style={styles.thumbWrap}
              >
                <Image
                  testID="bill-thumb"
                  source={{ uri: photoUri }}
                  contentFit="cover"
                  style={styles.thumb}
                />
              </PressableScale>
            ) : (
              <CircleButton
                icon={ReceiptText}
                accessibilityLabel={t('bill')}
                onPress={openCamera}
              />
            )}
          </View>

          {canEnroll ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('receipts')}
              onPress={() => router.push('/receipts')}
              style={styles.receipts}
            >
              <Icon icon={ReceiptText} color={colors.ink} />
              <Text style={typography.label}>{t('receipts')}</Text>
            </PressableScale>
          ) : null}
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('categories')}
            style={styles.cats}
          >
            {CATEGORIES.map(({ id, icon }) => (
              <CategoryChip
                key={id}
                id={id}
                icon={icon}
                label={t(`cat.${id}`)}
                on={category === id}
                onPick={setCategory}
              />
            ))}
          </View>

          <Text
            accessibilityLiveRegion="polite"
            accessibilityLabel={t('amount')}
            accessibilityValue={{ text: formatVnd(amount) }}
            style={styles.amount}
          >
            −{formatVnd(amount)}
          </Text>

          <Keypad onKey={onKey} diameter={keyDiameter} labels={padLabels} />
        </View>
      </Sheet>
      {shooting ? (
        <BillCamera onUse={acceptPhoto} onClose={closeCamera} />
      ) : null}
    </View>
  );
}

type ChipProps = {
  id: ExpenseCategory;
  icon: LucideIcon;
  label: string;
  on: boolean;
  onPick: (id: ExpenseCategory) => void;
};

const CategoryChip = memo(function CategoryChip({
  id,
  icon,
  label,
  on,
  onPick,
}: ChipProps) {
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, selected: on }}
      aria-checked={on}
      aria-selected={on}
      pressedScale={0.96}
      onPress={() => onPick(id)}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Icon icon={icon} color={on ? colors.onInk : colors.ink} />
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  receipts: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  body: { gap: space[3] },
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  thumbWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSoft,
  },
  thumb: { width: 56, height: 56 },
  cats: { flexDirection: 'row', gap: space[2] },
  chip: {
    flex: 1,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  chipOn: { backgroundColor: colors.ink },
  chipText: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.ink,
  },
  chipTextOn: { color: colors.onInk },
  amount: {
    ...typography.total,
    textAlign: 'center',
    color: colors.danger,
    fontVariant: ['tabular-nums'],
  },
  error: { ...typography.caption, textAlign: 'center', color: colors.danger },
  footer: { gap: space[2] },
});
