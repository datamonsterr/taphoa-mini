import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import {
  Bell,
  ChevronLeft,
  HandCoins,
  Pencil,
  SlidersHorizontal,
} from 'lucide-react-native';
import { useState, type ComponentProps } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CircleButton,
  Icon,
  MoneyText,
  PressableScale,
  Text,
} from '@/components/ui';
import {
  isApiError,
  useCustomer,
  useDebtEntries,
  useStore,
  type DebtEntry,
} from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { selectIsLead, useSessionStore } from '@/stores/session';
import { colors, radius, size, space, typography } from '@/theme';

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
  amount > 0 ? `+${formatVnd(amount)}` : formatVnd(amount);

/** "Trả nợ · Tiền mặt" / "Điều chỉnh · lý do": the kind, then how or why. */
function entryTitle(entry: DebtEntry, t: Translate) {
  const detail =
    entry.kind === 'repayment' && entry.method
      ? t(`method.${entry.method}`)
      : entry.kind === 'adjustment'
        ? entry.reason
        : null;
  return detail
    ? `${t(`kind.${entry.kind}`)} · ${detail}`
    : t(`kind.${entry.kind}`);
}

function LedgerRow({ entry, t }: { entry: DebtEntry; t: Translate }) {
  const title = entryTitle(entry, t);
  const date = dayMonth(entry.business_date);
  const balance = fill(t('ledger.balance'), {
    amount: formatVnd(entry.balance_after),
  });
  return (
    <View
      accessible
      testID="ledger-row"
      accessibilityLabel={`${title}, ${signed(entry.amount)}, ${date}, ${balance}`}
      style={styles.ledgerRow}
    >
      <View style={styles.rowText}>
        <Text style={styles.label}>{title}</Text>
        <Text style={styles.caption}>{date}</Text>
      </View>
      <View style={styles.amounts}>
        <Text
          style={[
            styles.label,
            { color: entry.amount > 0 ? colors.danger : colors.success },
          ]}
        >
          {signed(entry.amount)}
        </Text>
        <Text style={styles.caption}>{balance}</Text>
      </View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${value}`}
      style={styles.fact}
    >
      <Text style={styles.caption}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
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
  const isLead = useSessionStore(selectIsLead);
  const sessionStore = useSessionStore((s) => s.session?.store);
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

  const data = customer.data;
  if (!data) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
        <View style={styles.header}>{back}</View>
        {customer.isPending ? (
          <ActivityIndicator accessibilityLabel={t('loading')} />
        ) : isApiError(customer.error) && customer.error.status === 404 ? (
          <Text style={styles.message}>{t('customer.notFound')}</Text>
        ) : (
          <View style={styles.message}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {t('error')}
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('retry')}
              onPress={() => void customer.refetch()}
              style={styles.chip}
            >
              <Text style={styles.label}>{t('retry')}</Text>
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

  const header = (
    <View style={styles.headerContent}>
      <View style={styles.card}>
        <View
          accessible
          testID="customer-balance"
          accessibilityLabel={`${balanceLabel} ${formatVnd(Math.abs(data.balance))}`}
        >
          <Text style={styles.caption}>{balanceLabel}</Text>
          <MoneyText amount={Math.abs(data.balance)} variant="price" />
        </View>
        {overdueDays === null ? null : <OverdueBadge days={overdueDays} />}
        {overLimit ? (
          <Text accessibilityRole="alert" style={styles.warning}>
            {t('overLimit')}
          </Text>
        ) : null}
        {data.phone ? (
          <Fact label={t('customer.phone')} value={data.phone} />
        ) : null}
        <Fact
          label={t('customer.limit')}
          value={
            data.credit_limit === null
              ? t('customer.noLimit')
              : formatVnd(data.credit_limit)
          }
        />
        {data.note ? (
          <Fact label={t('customer.note')} value={data.note} />
        ) : null}
        {data.archived ? (
          <Text style={styles.caption}>{t('customer.archived')}</Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        <ActionButton
          primary
          icon={HandCoins}
          label={t('action.collect')}
          onPress={() => setSheet('collect')}
        />
        <ActionButton
          icon={Bell}
          label={t('action.remind')}
          disabled={data.balance <= 0}
          onPress={() => void remind()}
        />
        {isLead ? (
          <ActionButton
            icon={SlidersHorizontal}
            label={t('action.adjust')}
            onPress={() => setSheet('adjust')}
          />
        ) : null}
      </View>
      {shareFailed ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {t('remind.error')}
        </Text>
      ) : null}

      <Text accessibilityRole="header" style={styles.section}>
        {t('ledger.title')}
      </Text>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        {back}
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
          {data.name}
        </Text>
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
            <ActivityIndicator accessibilityLabel={t('loading')} />
          ) : entries.isError ? (
            <View style={styles.message}>
              <Text accessibilityRole="alert" style={styles.errorText}>
                {t('ledger.error')}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('retry')}
                onPress={() => void entries.refetch()}
                style={styles.chip}
              >
                <Text style={styles.label}>{t('retry')}</Text>
              </PressableScale>
            </View>
          ) : (
            <Text style={styles.caption}>{t('ledger.empty')}</Text>
          )
        }
        ListFooterComponent={
          entries.isFetchingNextPage ? (
            <ActivityIndicator accessibilityLabel={t('loading')} />
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
  title: { ...typography.heading, flex: 1, color: colors.ink },
  content: { paddingHorizontal: space[4] },
  headerContent: { gap: space[3], paddingBottom: space[2] },
  card: {
    gap: space[3],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space[3],
  },
  factValue: { ...typography.label, flexShrink: 1, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  action: {
    flexGrow: 1,
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
  section: { ...typography.heading, color: colors.ink },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapMin,
    paddingVertical: space[2],
  },
  rowText: { flex: 1, gap: space[1] },
  amounts: { alignItems: 'flex-end', gap: space[1] },
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
