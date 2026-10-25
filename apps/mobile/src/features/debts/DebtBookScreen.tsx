import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, MoneyText, PressableScale, Text } from '@/components/ui';
import { useCustomers, useDebtSummary, type Customer } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { OverdueBadge } from './OverdueBadge';
import { debtStrings } from './strings';

/** Negative balance: the store holds the customer's money. */
const balanceColor = (balance: number) =>
  balance < 0 ? colors.success : balance === 0 ? colors.inkMuted : colors.ink;

export function DebtBookScreen() {
  const t = useT(debtStrings);
  const insets = useSafeAreaInsets();
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

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space[4] }]}>
      <View style={styles.header}>
        <CircleButton
          icon={ChevronLeft}
          accessibilityLabel={t('back')}
          onPress={goBack}
        />
        <Text accessibilityRole="header" style={styles.title}>
          {t('book.title')}
        </Text>
      </View>

      <View style={styles.summary}>
        {summary.data ? (
          <>
            <View
              accessible
              accessibilityLabel={`${t('book.total')} ${formatVnd(summary.data.total_outstanding)}`}
              style={styles.summaryTotal}
            >
              <Text style={styles.caption}>{t('book.total')}</Text>
              <MoneyText
                amount={summary.data.total_outstanding}
                variant="heading"
              />
            </View>
            <View
              accessible
              accessibilityLabel={`${overdueLabel}, ${formatVnd(summary.data.overdue_amount)}`}
              style={styles.summaryOverdue}
            >
              <Text style={styles.overdueText}>{overdueLabel}</Text>
              <MoneyText
                amount={summary.data.overdue_amount}
                variant="label"
                color={colors.warning}
              />
            </View>
          </>
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
              <Text style={styles.label}>{t('retry')}</Text>
            </PressableScale>
          </View>
        ) : (
          <ActivityIndicator accessibilityLabel={t('loading')} />
        )}
      </View>

      <View style={styles.filters}>
        <TextInput
          accessibilityLabel={t('search')}
          placeholder={t('search')}
          placeholderTextColor={colors.inkMuted}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          autoCorrect={false}
          style={styles.input}
        />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('book.filterOverdue')}
          accessibilityState={{ selected: overdueOnly }}
          onPress={() => setOverdueOnly((on) => !on)}
          style={[styles.chip, overdueOnly && styles.chipOn]}
        >
          <Text style={[styles.label, overdueOnly && styles.chipTextOn]}>
            {t('book.filterOverdue')}
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
            <ActivityIndicator accessibilityLabel={t('loading')} />
          ) : customers.isError ? (
            <View style={styles.message}>
              <Text accessibilityRole="alert" style={styles.errorText}>
                {t('book.error')}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('retry')}
                onPress={() => void customers.refetch()}
                style={styles.chip}
              >
                <Text style={styles.label}>{t('retry')}</Text>
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
            <ActivityIndicator accessibilityLabel={t('loading')} />
          ) : null
        }
        renderItem={({ item }) => {
          const overdueDays =
            item.overdue && item.debt_age_days !== null
              ? item.debt_age_days
              : null;
          return (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={
                `${item.name}, ${formatVnd(item.balance)}` +
                (overdueDays === null
                  ? ''
                  : `, ${fill(t('book.badgeSpoken'), { days: overdueDays })}`)
              }
              onPress={() => open(item)}
              style={styles.row}
            >
              <View style={styles.rowText}>
                <Text style={styles.label} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.phone ? (
                  <Text style={styles.caption} numberOfLines={1}>
                    {item.phone}
                  </Text>
                ) : null}
                {overdueDays === null ? null : (
                  <OverdueBadge days={overdueDays} />
                )}
              </View>
              <MoneyText
                amount={item.balance}
                variant="label"
                color={balanceColor(item.balance)}
              />
            </PressableScale>
          );
        }}
      />
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
  title: { ...typography.title, color: colors.ink },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3],
    marginHorizontal: space[4],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  summaryTotal: { flexGrow: 1, flexBasis: '45%', gap: space[1] },
  summaryOverdue: {
    flexGrow: 1,
    flexBasis: '45%',
    gap: space[1],
    justifyContent: 'flex-end',
  },
  summaryError: { flex: 1, gap: space[3] },
  overdueText: { ...typography.caption, color: colors.warning },
  filters: { gap: space[2], paddingHorizontal: space[4] },
  input: {
    ...typography.body,
    color: colors.ink,
    minHeight: size.tapMin,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
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
    minHeight: size.tapMin,
    paddingVertical: space[3],
  },
  rowText: { flex: 1, gap: space[1] },
  message: { ...typography.body, gap: space[3], padding: space[4] },
});
