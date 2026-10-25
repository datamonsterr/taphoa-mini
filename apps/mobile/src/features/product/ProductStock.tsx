import { StyleSheet, View } from 'react-native';

import { Text, PressableScale } from '@/components/ui';
import { StockBadge } from '@/components/ui/StockBadge';
import { useStore } from '@/lib/api/hooks';
import type { Product } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { ProductThreshold } from './ProductThreshold';
import { fill, strings } from './strings';

export function ProductStock({
  product,
  isLead,
  onAdjust,
}: {
  product: Product;
  isLead: boolean;
  onAdjust: () => void;
}) {
  const t = useT(strings);
  const store = useStore();
  const threshold =
    product.low_stock_threshold ?? store.data?.low_stock_threshold;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{t('stock')}</Text>
      {product.stock_quantity === null ? (
        <Text>{t('untracked')}</Text>
      ) : (
        <StockBadge
          quantity={product.stock_quantity}
          status={product.stock_status}
        />
      )}
      {threshold !== undefined ? (
        <Text>{fill(t('threshold'), { n: threshold })}</Text>
      ) : null}
      {store.isError && product.low_stock_threshold === null ? (
        <Text accessibilityRole="alert">{t('thresholdError')}</Text>
      ) : null}
      {isLead ? (
        <ProductThreshold
          key={`${product.id}:${product.low_stock_threshold}`}
          product={product}
        />
      ) : null}
      {isLead ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('adjust')}
          onPress={onAdjust}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t('adjust')}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: space[4],
    gap: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  heading: { ...typography.label, color: colors.ink },
  button: {
    minHeight: 56,
    paddingHorizontal: space[4],
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  buttonText: { ...typography.label, color: colors.onInk },
});
