import { router } from 'expo-router';
import { PressableScale, Text, MoneyText } from '@/components/ui';
import { useRecentSales } from '@/lib/api/salesActions';
import { useT } from '@/lib/i18n';
import { transactionStrings } from '@/features/dashboard/transactionStrings';
import { Action, Page, styles } from './kit';

export function RecentSalesScreen() {
  const t = useT(transactionStrings);
  const sales = useRecentSales();
  const items = sales.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Page>
      <Action label={t('back')} onPress={() => router.replace('/dashboard')} />
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
      {!sales.isPending && !sales.isError && !items.length ? (
        <Text>{t('empty')}</Text>
      ) : null}
      {items.map((sale) => (
        <PressableScale
          key={sale.id}
          accessibilityRole="button"
          accessibilityLabel={`${sale.code}, ${t(sale.status)}`}
          onPress={() =>
            router.push({ pathname: '/sale/[id]', params: { id: sale.id } })
          }
          style={styles.card}
        >
          <Text style={styles.label}>
            {sale.code} · {sale.business_date}
          </Text>
          <Text>
            {new Date(sale.sold_at).toLocaleTimeString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Asia/Ho_Chi_Minh',
            })}{' '}
            · {t(sale.payment_method)}
          </Text>
          <MoneyText amount={sale.total} variant="label" />
          <Text>{t(sale.status)}</Text>
        </PressableScale>
      ))}
      {sales.hasNextPage ? (
        <Action
          label={t('more')}
          disabled={sales.isFetchingNextPage}
          onPress={() => void sales.fetchNextPage()}
        />
      ) : null}
    </Page>
  );
}
