import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import type { Product } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { colors, space, typography } from '@/theme';

export function BarcodeIndicator({
  code,
  product,
}: {
  code: string;
  product: Product | null;
}) {
  return (
    <View
      pointerEvents="none"
      style={styles.root}
      testID="barcode-indicator"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.pill}>
        <Text style={styles.name}>
          {product
            ? (product.name ?? 'Hàng chưa đặt tên')
            : `Mã vạch · ${code}`}
        </Text>
        {product ? (
          <Text style={styles.price}>{formatVnd(product.price)}</Text>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    // Board 01: the label hangs under an accent line two thirds down the viewfinder.
    left: '12%',
    right: '12%',
    top: '63%',
    alignItems: 'center',
    borderTopWidth: 3,
    borderColor: colors.accent,
    paddingTop: space[3],
  },
  pill: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    alignItems: 'center',
  },
  name: { ...typography.label, color: colors.ink },
  price: {
    ...typography.price,
    fontSize: 32,
    lineHeight: 38,
    color: colors.ink,
  },
});
