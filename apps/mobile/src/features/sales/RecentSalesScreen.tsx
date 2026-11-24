import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PressableScale, Text, MoneyText } from '@/components/ui';
import { useRecentSales } from '@/lib/api/salesActions';
import { useT } from '@/lib/i18n';
import { transactionStrings } from '@/features/dashboard/transactionStrings';
import { space } from '@/theme';
import { Action, BackPill, StatusPill, saleStamp, styles } from './kit';

export function RecentSalesScreen() {
  const t = useT(transactionStrings);
  const insets = useSafeAreaInsets();
  const sales = useRecentSales();
  const items = sales.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <FlashList
      testID="recent-sales-list"
      style={styles.page}
      data={items}
      keyExtractor={(sale) => sale.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: space[4],
        paddingTop: insets.top + space[4],
        paddingBottom: insets.bottom + space[8],
      }}
      onEndReached={() => {
        if (sales.hasNextPage && !sales.isFetchingNextPage)
          void sales.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <View style={{ gap: space[4], marginBottom: space[4] }}>
          <BackPill
            label={t('back')}
            text={t('reports')}
            onPress={() => router.replace('/dashboard')}
          />
          <Text accessibilityRole="header" style={styles.heading}>
            {t('recent')}
          </Text>
          {sales.isPending ? (
            <Text accessibilityRole="progressbar">{t('loading')}</Text>
          ) : null}
          {sales.isError ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {t('error')}
              </Text>
              <Action label={t('retry')} onPress={() => void sales.refetch()} />
            </>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        !sales.isPending && !sales.isError ? <Text>{t('empty')}</Text> : null
      }
      ListFooterComponent={
        sales.hasNextPage ? (
          <Action
            label={t('more')}
            disabled={sales.isFetchingNextPage}
            onPress={() => void sales.fetchNextPage()}
          />
        ) : null
      }
      renderItem={({ item: sale }) => (
        <PressableScale
          testID="sale-row"
          accessibilityRole="button"
          accessibilityLabel={`${sale.code}, ${t(sale.status)}`}
          onPress={() =>
            router.push({ pathname: '/sale/[id]', params: { id: sale.id } })
          }
          style={[styles.card, { marginBottom: space[4] }]}
        >
          <Text style={styles.label}>
            {sale.code} · {saleStamp(sale.sold_at)}
          </Text>
          <Text style={styles.body}>{t(sale.payment_method)}</Text>
          <MoneyText amount={sale.total} variant="label" />
          <StatusPill
            label={t(sale.status)}
            voided={sale.status === 'voided'}
          />
        </PressableScale>
      )}
    />
  );
}
