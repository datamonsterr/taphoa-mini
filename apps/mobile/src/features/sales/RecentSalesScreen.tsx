import { router } from 'expo-router';
import { PressableScale, Text, MoneyText } from '@/components/ui';
import { useRecentSales } from '@/lib/api/salesActions';
import { useT } from '@/lib/i18n';
import { transactionStrings } from '@/features/dashboard/transactionStrings';
import { Action, BackPill, Page, StatusPill, saleStamp, styles } from './kit';

export function RecentSalesScreen() {
  const t = useT(transactionStrings);
  const sales = useRecentSales();
  const items = sales.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Page>
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
            {sale.code} · {saleStamp(sale.sold_at)}
          </Text>
          <Text style={styles.body}>{t(sale.payment_method)}</Text>
          <MoneyText amount={sale.total} variant="label" />
          <StatusPill
            label={t(sale.status)}
            voided={sale.status === 'voided'}
          />
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
