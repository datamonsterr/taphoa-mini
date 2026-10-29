import * as Haptics from 'expo-haptics';
import { Banknote, Calculator, X } from 'lucide-react-native';
import { onlineManager } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  applyKey,
  CheckButton,
  CircleButton,
  DifferencePill,
  Icon,
  Keypad,
  useKeypadDiameter,
  MoneyText,
  PressableScale,
  Sheet,
  type KeypadKeyId,
  Text,
} from '@/components/ui';
import { useCreateDayClose, useDayClose, useTodayReport } from '@/lib/api';
import { useIsLead } from '@/features/auth/useMembership';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { useLabels, useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { dismissSheet } from '../dashboard/dismiss';
import {
  closeDifference,
  countedFromDigits,
  dayMonth,
  MAX_CASH_DIGITS,
} from './difference';
import { closeStrings } from './strings';

/** Sheet height on the Close board. */
const SHEET_HEIGHT = 748;

const differenceLabels = (t: (key: string) => string) => ({
  match: t('diff.match'),
  short: t('diff.short'),
  extra: t('diff.extra'),
});
const keypadLabels = (t: (key: string) => string) => ({
  delete: t('keypad.delete'),
});

/** One line of the day's debt movements; a day without that movement leaves it out. */
function DebtLine({ label, amount }: { label: string; amount: number }) {
  if (amount <= 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${formatVnd(amount)}`}
      style={styles.debtLine}
    >
      <Text style={styles.debtLabel}>{label}</Text>
      <MoneyText amount={amount} variant="label" />
    </View>
  );
}

function CloseBoard() {
  const t = useT(closeStrings);
  const diffLabels = useLabels(closeStrings, differenceLabels);
  const padLabels = useLabels(closeStrings, keypadLabels);
  const keyDiameter = useKeypadDiameter(68);
  const date = useMemo(() => businessDate(), []);
  const report = useTodayReport(date);
  const dayClose = useDayClose(date);
  const create = useCreateDayClose();
  const { mutateAsync: createAsync } = create;
  const [digits, setDigits] = useState('');
  const [failed, setFailed] = useState<'save' | 'offline' | null>(null);

  const closed = dayClose.data ?? null;
  const expected = closed?.expected_cash ?? report.data?.expected_cash;
  const counted = closed ? closed.counted_cash : countedFromDigits(digits);
  // Before closing the lines come from today's report; after, from the stored close.
  const cashRepayments = closed
    ? (closed.cash_repayments ?? 0)
    : (report.data?.cash_repayments ?? 0);
  const creditSales = closed
    ? (closed.credit_sales ?? 0)
    : (report.data?.credit_sales ?? 0);

  const onKey = useCallback(
    (key: KeypadKeyId) =>
      setDigits((value) => applyKey(value, key, MAX_CASH_DIGITS)),
    [],
  );

  const refetch = useCallback(() => {
    void report.refetch();
    void dayClose.refetch();
  }, [report, dayClose]);

  const submit = useCallback(async () => {
    setFailed(null);
    // The close records the cash counted now. Offline it is refused, not queued: sent minutes
    // later it would carry a different count, and the seller must know it is not recorded.
    if (!onlineManager.isOnline()) {
      setFailed('offline');
      return;
    }
    try {
      await createAsync({ date, counted_cash: countedFromDigits(digits) });
    } catch {
      setFailed(onlineManager.isOnline() ? 'save' : 'offline');
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    dismissSheet();
  }, [createAsync, date, digits]);

  const hasError = report.isError || dayClose.isError;
  const ready = !hasError && expected !== undefined && !dayClose.isPending;

  return (
    <Sheet
      height={SHEET_HEIGHT}
      onClose={dismissSheet}
      footer={
        ready && !closed ? (
          <View style={styles.footer}>
            {failed ? (
              <Text accessibilityRole="alert" style={styles.saveError}>
                {t(failed === 'offline' ? 'offlineError' : 'saveError')}
              </Text>
            ) : null}
            <CheckButton
              variant="ink"
              block
              accessibilityLabel={t('save')}
              disabled={create.isPending || digits === ''}
              onPress={submit}
            />
          </View>
        ) : undefined
      }
    >
      <View style={styles.body}>
        <View style={styles.topRow}>
          <CircleButton
            icon={X}
            accessibilityLabel={t('close')}
            onPress={dismissSheet}
            testID="close-close"
          />
          <Text accessibilityRole="header" style={styles.title}>
            {t('screen')}
          </Text>
          <Text style={styles.date}>{dayMonth(date)}</Text>
        </View>

        {hasError ? (
          <View accessibilityRole="alert" style={styles.error}>
            <Text style={styles.errorText}>{t('error')}</Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('retry')}
              pressedScale={0.96}
              onPress={refetch}
              style={styles.retry}
            >
              <Text style={styles.retryText}>{t('retry')}</Text>
            </PressableScale>
          </View>
        ) : null}

        {!hasError && !ready ? (
          <View
            testID="close-skeleton"
            accessibilityRole="progressbar"
            accessibilityLabel={t('loading')}
            style={styles.skeleton}
          />
        ) : null}

        {ready ? (
          <>
            <View
              accessible
              accessibilityLabel={`${t('expected')} ${formatVnd(expected)}`}
              style={styles.expected}
            >
              <Icon icon={Calculator} color={colors.inkMuted} />
              <View style={styles.spacer} />
              <MoneyText
                amount={expected}
                variant="heading"
                style={styles.expectedAmount}
              />
            </View>

            <View style={styles.countedRow}>
              <Icon icon={Banknote} color={colors.inkMuted} />
              <Text
                accessibilityLiveRegion="polite"
                accessibilityLabel={t('counted')}
                accessibilityValue={{ text: formatVnd(counted) }}
                style={styles.counted}
              >
                {formatVnd(counted)}
              </Text>
            </View>

            <DifferencePill
              difference={closeDifference(counted, expected).difference}
              labels={diffLabels}
            />

            <DebtLine label={t('cashRepayments')} amount={cashRepayments} />
            <DebtLine label={t('creditSales')} amount={creditSales} />

            {closed ? (
              <Text style={styles.closedNote}>{t('closed')}</Text>
            ) : (
              <Keypad onKey={onKey} diameter={keyDiameter} labels={padLabels} />
            )}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[3] },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  title: { ...typography.heading, flex: 1, color: colors.ink },
  date: {
    ...typography.caption,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  expected: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    height: size.tapLg,
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  spacer: { flex: 1 },
  expectedAmount: { fontSize: 24, lineHeight: 30 },
  countedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingLeft: 20,
    paddingRight: space[1],
  },
  counted: {
    ...typography.total,
    flex: 1,
    textAlign: 'right',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  debtLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: 20,
  },
  debtLabel: { ...typography.caption, color: colors.inkMuted },
  closedNote: {
    ...typography.label,
    textAlign: 'center',
    color: colors.success,
  },
  footer: { gap: space[2] },
  saveError: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.danger,
  },
  skeleton: {
    height: 220,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  error: { alignItems: 'center', gap: space[3], paddingVertical: space[6] },
  errorText: { ...typography.label, color: colors.danger },
  retry: {
    minHeight: size.tapMin,
    paddingHorizontal: space[6],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  retryText: { ...typography.label, color: colors.ink },
});

/** Only the Lead sees or closes the day's cash; the server answers 403 to a Seller. */
function CloseForbidden() {
  const t = useT(closeStrings);
  return (
    <Sheet height={SHEET_HEIGHT} onClose={dismissSheet}>
      <View style={styles.body}>
        <View style={styles.topRow}>
          <CircleButton
            icon={X}
            accessibilityLabel={t('close')}
            onPress={dismissSheet}
            testID="close-close"
          />
          <Text accessibilityRole="header" style={styles.title}>
            {t('screen')}
          </Text>
        </View>
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{t('forbidden')}</Text>
        </View>
      </View>
    </Sheet>
  );
}

export function CloseScreen() {
  return useIsLead() ? <CloseBoard /> : <CloseForbidden />;
}
