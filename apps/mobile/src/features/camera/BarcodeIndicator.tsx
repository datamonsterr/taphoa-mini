import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import type { Product } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { colors, radius, space, typography } from '@/theme';

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
      <View style={styles.line} />
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
    left: space[6],
    right: space[6],
    bottom: space[6],
    alignItems: 'center',
    gap: space[2],
  },
  line: {
    width: '80%',
    height: 12,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderColor: colors.accent,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  pill: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    alignItems: 'center',
  },
  name: { ...typography.caption, color: colors.ink },
  price: { ...typography.price, color: colors.ink },
});
