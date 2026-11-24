import { Redirect, useLocalSearchParams } from 'expo-router';

import { stockHref } from '@/features/stock/stockHref';

/** Compatibility alias for old links: replaces into the Kho tab's stock segment. */
export default function StockAlias() {
  const { status } = useLocalSearchParams<{ status?: string }>();
  return <Redirect href={stockHref(status)} />;
}
