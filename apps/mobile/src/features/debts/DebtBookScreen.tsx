import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { ChevronLeft, Search, UserPlus } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import { useCustomers, useDebtSummary, type Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';

import { CustomerPicker } from './CustomerPicker';
import { OverdueBadge } from './OverdueBadge';
import { debtStrings } from './strings';

/** Negative balance: the store holds the customer money, shown as Trả dư, never a bare minus. */
const balanceColor = (balance: number) =>
  balance < 0 ? colors.success : balance === 0 ? colors.inkMuted : colors.ink;

const AVATAR_TONES = [
  { background: colors.accentSoft, color: colors.accent },
  { background: colors.successSoft, color: colors.success },
  { background: colors.warningSoft, color: colors.warning },
  { background: colors.surfaceSoft, color: colors.ink },
] as const;

/** Stable tone per customer so a row keeps its colour between visits. */
const avatarTone = (id: string) => {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return AVATAR_TONES[sum % AVATAR_TONES.length]!;
};

const initialOf = (name: string) =>
  (Array.from(name.trim())[0] ?? '?').toUpperCase();

export function DebtBookScreen() {
  const t = useT(debtStrings);
  const insets = useSafeAreaInsets();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const search = query.trim();
  const summary = useDebtSummary();
  const customers = useCustomers({
    ...(search ? { query: search } : {}),
    ...(overdueOnly ? { overdue: true } : {}),
  });

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const open = (customer: Customer) =>
    router.push({ pathname: '/customer/[id]', params: { id: customer.id } });
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([summary.refetch(), customers.refetch()]);
    } finally {
      setRefreshing(false);
    }
  };

  const overdueLabel = summary.data
    ? fill(t('book.overdue'), { count: summary.data.overdue_count })
    : '';
  const ageText = (days: number) =>
    days === 0
      ? t('book.ageToday')
      : days === 1
        ? t('book.ageYesterday')
        : fill(t('book.ageDays'), { days });
  const title = t('book.title');
  const backLabel = t('back');
  const addLabel = t('book.add');
  const searchLabel = t('search');
  const allLabel = t('book.filterAll');
  const overdueFilterLabel = t('book.filterOverdue');
  const retryLabel = t('retry');
  const loadingLabel = t('loading');

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={backLabel}
          onPress={goBack}
        />
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <CircleButton
          icon={UserPlus}
          variant="ink"
          accessibilityLabel={addLabel}
          onPress={() => setCreating(true)}
        />
      </View>

      {summary.data ? (
        <View style={styles.stats}>
          <View
            accessible
            accessibilityLabel={
              t('book.total') + ' ' + formatVnd(summary.data.total_outstanding)
            }
            style={[styles.stat, styles.statWide]}
          >
            <Text style={styles.statCaptionOnInk}>
              {fill(t('book.totalCaption'), {
                count: summary.data.customers_with_debt,
              })}
            </Text>
            <Text style={styles.statTotal} numberOfLines={1}>
              {formatVnd(summary.data.total_outstanding)}
            </Text>
          </View>
          <View
            accessible
            accessibilityLabel={
              overdueLabel + ', ' + formatVnd(summary.data.overdue_amount)
            }
            style={[styles.stat, styles.statDanger]}
          >
            <Text style={styles.statCaptionDanger}>
              {fill(t('book.overdueCaption'), {
                count: summary.data.overdue_count,
              })}
            </Text>
            <Text style={styles.statDangerValue} numberOfLines={1}>
              {formatVnd(summary.data.overdue_amount)}
            </Text>
          </View>
        </View>
      ) : summary.isError ? (
        <View style={styles.summaryError}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {t('book.summaryError')}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('book.summaryRetry')}
            onPress={() => void summary.refetch()}
            style={styles.chip}
          >
            <Text style={styles.label}>{retryLabel}</Text>
          </PressableScale>
        </View>
      ) : (
        <View style={styles.summaryLoading}>
          <ActivityIndicator accessibilityLabel={loadingLabel} />
        </View>
      )}

      <View style={styles.searchField}>
        <Icon icon={Search} color={colors.inkMuted} />
        <TextInput
          accessibilityLabel={searchLabel}
          placeholder={searchLabel}
          placeholderTextColor={colors.inkMuted}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          autoCorrect={false}
          style={styles.searchInput}
        />
      </View>

      <View accessibilityRole="radiogroup" style={styles.filters}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={allLabel}
          accessibilityState={{ selected: !overdueOnly }}
          onPress={() => setOverdueOnly(false)}
          style={[styles.chip, !overdueOnly && styles.chipOn]}
        >
          <Text style={[styles.label, !overdueOnly && styles.chipTextOn]}>
            {allLabel}
          </Text>
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={overdueFilterLabel}
          accessibilityState={{ selected: overdueOnly }}
          onPress={() => setOverdueOnly(true)}
          style={[styles.chip, overdueOnly && styles.chipOn]}
        >
          <Text style={[styles.label, overdueOnly && styles.chipTextOn]}>
            {overdueFilterLabel}
          </Text>
        </PressableScale>
      </View>

      <FlashList
        testID="debt-list"
        data={customers.data ?? []}
        keyExtractor={(customer) => customer.id}
        refreshing={refreshing}
        onRefresh={refresh}
        onEndReached={() => {
          if (customers.hasNextPage && !customers.isFetchingNextPage)
            void customers.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + space[6] },
        ]}
        ListEmptyComponent={
          customers.isPending ? (
            <ActivityIndicator accessibilityLabel={loadingLabel} />
          ) : customers.isError ? (
            <View style={styles.message}>
              <Text accessibilityRole="alert" style={styles.errorText}>
                {t('book.error')}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={retryLabel}
                onPress={() => void customers.refetch()}
                style={styles.chip}
              >
                <Text style={styles.label}>{retryLabel}</Text>
              </PressableScale>
            </View>
          ) : (
            <Text style={styles.message}>
              {search || overdueOnly ? t('book.noMatch') : t('book.empty')}
            </Text>
          )
        }
        ListFooterComponent={
          customers.isFetchingNextPage ? (
            <ActivityIndicator accessibilityLabel={loadingLabel} />
          ) : null
        }
        renderItem={({ item }) => {
          const overdueDays =
            item.overdue && item.debt_age_days !== null
              ? item.debt_age_days
              : null;
          const credit = item.balance < 0;
          const tone = avatarTone(item.id);
          const spokenAmount = credit
            ? fill(t('book.creditSpoken'), {
                amount: formatVnd(Math.abs(item.balance)),
              })
            : formatVnd(item.balance);
          return (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={
                item.name +
                ', ' +
                spokenAmount +
                (overdueDays === null
                  ? ''
                  : ', ' + fill(t('book.badgeSpoken'), { days: overdueDays }))
              }
              onPress={() => open(item)}
              style={[styles.row, overdueDays === null && styles.rowMuted]}
            >
              <View
                style={[styles.avatar, { backgroundColor: tone.background }]}
              >
                <Text style={[styles.avatarText, { color: tone.color }]}>
                  {initialOf(item.name)}
                </Text>
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.caption} numberOfLines={1}>
                  {item.phone ?? t('book.noPhone')}
                </Text>
              </View>
              <View style={styles.rowEnd}>
                <Text
                  style={[
                    styles.amount,
                    credit && styles.amountCredit,
                    { color: balanceColor(item.balance) },
                  ]}
                  numberOfLines={1}
                >
                  {credit
                    ? fill(t('book.credit'), {
                        amount: formatVnd(Math.abs(item.balance)),
                      })
                    : formatVnd(item.balance)}
                </Text>
                {item.balance > 0 && item.debt_age_days !== null ? (
                  <Text style={styles.caption} numberOfLines={1}>
                    {ageText(item.debt_age_days)}
                  </Text>
                ) : null}
                {overdueDays === null ? null : <OverdueBadge compact />}
              </View>
            </PressableScale>
          );
        }}
      />
      {creating ? (
        <CustomerPicker
          mode="create"
          onClose={() => setCreating(false)}
          onSelect={(customer) => {
            setCreating(false);
            open(customer);
          }}
          onCreate={(customer) => {
            setCreating(false);
            open(customer);
          }}
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
  title: { ...typography.title, color: colors.ink, flex: 1 },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3],
    marginHorizontal: space[4],
  },
  stat: {
    padding: space[4],
    borderRadius: radius.lg,
    gap: space[1],
  },
  statWide: { width: '100%', backgroundColor: colors.ink },
  statDanger: { width: '100%', backgroundColor: colors.dangerSoft },
  statCaptionOnInk: { ...typography.caption, color: colors.onInk },
  statTotal: {
    fontFamily: fontFamily.extrabold,
    fontSize: 32,
    lineHeight: 38,
    color: colors.onInk,
    fontVariant: ['tabular-nums'],
  },
  statCaptionDanger: { ...typography.caption, color: colors.danger },
  statDangerValue: {
    fontFamily: fontFamily.extrabold,
    fontSize: 22,
    lineHeight: 28,
    color: colors.danger,
    fontVariant: ['tabular-nums'],
  },
  summaryError: { gap: space[3], marginHorizontal: space[4] },
  summaryLoading: {
    marginHorizontal: space[4],
    minHeight: 100,
    justifyContent: 'center',
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: size.tapMin,
    marginHorizontal: space[4],
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    ...typography.body,
    backgroundColor: 'transparent',
  },
  filters: {
    flexDirection: 'row',
    gap: space[2],
    paddingHorizontal: space[4],
  },
  chip: {
    alignSelf: 'flex-start',
    minHeight: size.tapMin,
    paddingHorizontal: space[4],
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  chipOn: { backgroundColor: colors.ink },
  chipTextOn: { color: colors.onInk },
  label: { ...typography.label, color: colors.ink },
  caption: { ...typography.caption, color: colors.inkMuted },
  errorText: { ...typography.label, color: colors.danger },
  content: { paddingHorizontal: space[4] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: size.tapLg,
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfacePressed,
  },
  rowMuted: { opacity: 0.55 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: fontFamily.extrabold,
    fontSize: 22,
    lineHeight: 26,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...typography.label, color: colors.ink },
  rowEnd: { alignItems: 'flex-end', gap: space[1], flexShrink: 0 },
  amount: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    lineHeight: 26,
    fontVariant: ['tabular-nums'],
  },
  amountCredit: { fontSize: 17, lineHeight: 22 },
  message: { ...typography.body, gap: space[3], padding: space[4] },
});
