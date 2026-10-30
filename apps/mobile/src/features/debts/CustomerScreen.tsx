import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import {
  Banknote,
  ChevronLeft,
  Minus,
  Pencil,
  Plus,
  Share as ShareIcon,
} from 'lucide-react-native';
import { useState, type ComponentProps } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import {
  isApiError,
  useCustomer,
  useDebtEntries,
  useStore,
  type DebtEntry,
} from '@/lib/api';
import { useMembership } from '@/features/auth/useMembership';
import { clockTime } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { dayMonth } from '../close/difference';
import { AdjustmentSheet } from './AdjustmentSheet';
import { EditCustomerSheet } from './EditCustomerSheet';
import { OverdueBadge } from './OverdueBadge';
import { RepaymentSheet } from './RepaymentSheet';
import { buildReminderText } from './reminder';
import { debtStrings } from './strings';

type Sheet = 'collect' | 'adjust' | 'edit' | null;
type Translate = (key: string) => string;

const signed = (amount: number) =>
  amount > 0 ? '+' + formatVnd(amount) : formatVnd(amount);

/** Trả nợ · Tiền mặt / Điều chỉnh · lý do: the kind, then how or why. */
function entryTitle(entry: DebtEntry, t: Translate) {
  const detail =
    entry.kind === 'repayment' && entry.method
      ? t('method.' + entry.method)
      : entry.kind === 'adjustment'
        ? entry.reason
        : null;
  const kind = t('kind.' + entry.kind);
  return detail ? kind + ' · ' + detail : kind;
}

/**
 * Board ledger row: a coloured +/− tile, the entry kind, then date and time (dd/mm · hh:mm), and
 * the signed amount. The running balance stays in the spoken label only.
 */
function LedgerRow({ entry, t }: { entry: DebtEntry; t: Translate }) {
  const title = entryTitle(entry, t);
  const date = dayMonth(entry.business_date);
  const time = clockTime(entry.created_at);
  const when = time ? date + ' · ' + time : date;
  const balance = fill(t('ledger.balance'), {
    amount: formatVnd(entry.balance_after),
  });
  const debit = entry.amount > 0;
  return (
    <View
      accessible
      testID="ledger-row"
      accessibilityLabel={
        title + ', ' + signed(entry.amount) + ', ' + date + ', ' + balance
      }
      style={styles.ledgerRow}
    >
      <View
        style={[
          styles.ledgerIcon,
          { backgroundColor: debit ? colors.dangerSoft : colors.successSoft },
        ]}
      >
        <Icon
          icon={debit ? Plus : Minus}
          color={debit ? colors.danger : colors.success}
        />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.label}>{title}</Text>
        <Text style={styles.caption}>{when}</Text>
      </View>
      <Text
        style={[
          styles.ledgerAmount,
          { color: debit ? colors.danger : colors.success },
        ]}
        numberOfLines={1}
      >
        {signed(entry.amount)}
      </Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled = false,
  primary = false,
}: {
  icon: ComponentProps<typeof Icon>['icon'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const ink = primary ? colors.onInk : colors.ink;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      pressedScale={0.96}
      onPress={onPress}
      style={[
        styles.action,
        primary && styles.actionPrimary,
        disabled && styles.disabled,
      ]}
    >
      <Icon icon={icon} color={ink} />
      <Text style={[styles.label, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

export function CustomerScreen({ id }: { id: string }) {
  const t = useT(debtStrings);
  const insets = useSafeAreaInsets();
  const membership = useMembership();
  const isLead = membership?.member.role === 'lead';
  const sessionStore = membership?.store;
  const customer = useCustomer(id);
  const entries = useDebtEntries(id);
  const store = useStore();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const close = () => setSheet(null);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const back = (
    <CircleButton
      icon={ChevronLeft}
      accessibilityLabel={t('back')}
      onPress={goBack}
    />
  );
  const retryLabel = t('retry');
  const loadingLabel = t('loading');

  const data = customer.data;
  if (!data) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
        <View style={styles.header}>{back}</View>
        {customer.isPending ? (
          <ActivityIndicator accessibilityLabel={loadingLabel} />
        ) : isApiError(customer.error) && customer.error.status === 404 ? (
          <Text style={styles.message}>{t('customer.notFound')}</Text>
        ) : (
          <View style={styles.message}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {t('error')}
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={retryLabel}
              onPress={() => void customer.refetch()}
              style={styles.chip}
            >
              <Text style={styles.label}>{retryLabel}</Text>
            </PressableScale>
          </View>
        )}
      </View>
    );
  }

  const remind = async () => {
    const shop = store.data ?? sessionStore;
    const message = shop ? buildReminderText(data, shop) : null;
    if (!message) return;
    setShareFailed(false);
    try {
      await Share.share({ message });
    } catch {
      setShareFailed(true);
    }
  };

  const overdueDays =
    data.overdue && data.debt_age_days !== null ? data.debt_age_days : null;
  const overLimit =
    data.credit_limit !== null && data.balance > data.credit_limit;
  const balanceLabel =
    data.balance > 0
      ? t('customer.owes')
      : data.balance < 0
        ? t('customer.credit')
        : t('customer.settled');
  const limitText =
    data.credit_limit === null
      ? null
      : t('customer.limit') + ' ' + formatVnd(data.credit_limit);
  const adjustLabel = t('action.adjust');
  const ledgerTitle = t('ledger.title');
  const overLimitText = t('overLimit');
  const remindError = t('remind.error');
  const archivedText = t('customer.archived');

  const header = (
    <View style={styles.headerContent}>
      <View style={styles.card}>
        <View
          accessible
          testID="customer-balance"
          accessibilityLabel={
            balanceLabel + ' ' + formatVnd(Math.abs(data.balance))
          }
          style={styles.balance}
        >
          <Text style={styles.caption}>{balanceLabel}</Text>
          <Text style={styles.balanceAmount} numberOfLines={1}>
            {formatVnd(Math.abs(data.balance))}
          </Text>
        </View>
        {overdueDays === null ? null : <OverdueBadge days={overdueDays} />}
        {overLimit ? (
          <Text accessibilityRole="alert" style={styles.warning}>
            {overLimitText}
          </Text>
        ) : null}
        {limitText ? (
          <Text
            accessible
            accessibilityLabel={limitText}
            style={styles.cardNote}
          >
            {limitText}
          </Text>
        ) : null}
        {data.note ? (
          <Text
            accessible
            accessibilityLabel={t('customer.note') + ' ' + data.note}
            style={styles.cardNote}
          >
            {data.note}
          </Text>
        ) : null}
        {data.archived ? (
          <Text style={styles.caption}>{archivedText}</Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        <ActionButton
          primary
          icon={Banknote}
          label={t('action.collect')}
          onPress={() => setSheet('collect')}
        />
        <ActionButton
          icon={ShareIcon}
          label={t('action.remind')}
          disabled={data.balance <= 0}
          onPress={() => void remind()}
        />
      </View>
      {isLead ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={adjustLabel}
          pressedScale={0.96}
          onPress={() => setSheet('adjust')}
          style={styles.quietLink}
        >
          <Text style={styles.quietLinkText}>{adjustLabel}</Text>
        </PressableScale>
      ) : null}
      {shareFailed ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {remindError}
        </Text>
      ) : null}

      <Text accessibilityRole="header" style={styles.section}>
        {ledgerTitle}
      </Text>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        {back}
        <View style={styles.headerText}>
          <Text
            accessibilityRole="header"
            style={styles.title}
            numberOfLines={1}
          >
            {data.name}
          </Text>
          {data.phone ? (
            <Text style={styles.phone} numberOfLines={1}>
              {data.phone}
            </Text>
          ) : null}
        </View>
        <CircleButton
          icon={Pencil}
          accessibilityLabel={t('action.edit')}
          onPress={() => setSheet('edit')}
        />
      </View>

      <FlashList
        testID="ledger-list"
        data={entries.data ?? []}
        keyExtractor={(entry) => entry.id}
        ListHeaderComponent={header}
        onEndReached={() => {
          if (entries.hasNextPage && !entries.isFetchingNextPage)
            void entries.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + space[6] },
        ]}
        ListEmptyComponent={
          entries.isPending ? (
            <ActivityIndicator accessibilityLabel={loadingLabel} />
          ) : entries.isError ? (
            <View style={styles.message}>
              <Text accessibilityRole="alert" style={styles.errorText}>
                {t('ledger.error')}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={retryLabel}
                onPress={() => void entries.refetch()}
                style={styles.chip}
              >
                <Text style={styles.label}>{retryLabel}</Text>
              </PressableScale>
            </View>
          ) : (
            <Text style={styles.caption}>{t('ledger.empty')}</Text>
          )
        }
        ListFooterComponent={
          entries.isFetchingNextPage ? (
            <ActivityIndicator accessibilityLabel={loadingLabel} />
          ) : null
        }
        renderItem={({ item }) => <LedgerRow entry={item} t={t} />}
      />

      {sheet === 'collect' ? (
        <RepaymentSheet customer={data} onClose={close} />
      ) : null}
      {sheet === 'adjust' && isLead ? (
        <AdjustmentSheet customer={data} onClose={close} />
      ) : null}
      {sheet === 'edit' ? (
        <EditCustomerSheet
          customer={data}
          canArchive={isLead}
          onClose={close}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: space[3], backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { ...typography.heading, color: colors.ink },
  phone: {
    ...typography.caption,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  content: { paddingHorizontal: space[4] },
  headerContent: { gap: space[3], paddingBottom: space[2] },
  card: {
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[6],
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  balance: { alignItems: 'center', gap: space[2] },
  balanceAmount: {
    fontFamily: fontFamily.extrabold,
    fontSize: 48,
    lineHeight: 52,
    letterSpacing: -1,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  cardNote: {
    ...typography.caption,
    color: colors.inkMuted,
    textAlign: 'center',
  },
  actions: { flexDirection: 'row', gap: space[3] },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  actionPrimary: { backgroundColor: colors.ink },
  disabled: { opacity: 0.4 },
  quietLink: {
    alignSelf: 'center',
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    justifyContent: 'center',
  },
  quietLinkText: { ...typography.label, color: colors.inkMuted },
  section: { ...typography.heading, color: colors.ink, marginTop: space[1] },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapLg,
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfacePressed,
  },
  ledgerIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ledgerAmount: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    lineHeight: 26,
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  rowText: { flex: 1, minWidth: 0, gap: space[1] },
  label: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  warning: { ...typography.label, color: colors.warning },
  errorText: { ...typography.label, color: colors.danger },
  chip: {
    alignSelf: 'flex-start',
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  message: { ...typography.body, gap: space[3], padding: space[4] },
});
