import { memo } from 'react';
import { ScrollView, View } from 'react-native';

import { Text } from '@/components/ui';
import { formatVnd } from '@/lib/format';
import { cartLineKey, type CartLine } from '@/stores/cart';
import { UnitChooser } from '@/features/checkout/UnitChooser';

import { LineThumb } from '../checkout/LineThumb';
import { styles } from './payStyles';

const OrderItem = memo(function OrderItem({ line }: { line: CartLine }) {
  return (
    <View style={styles.item}>
      <View>
        <LineThumb uri={line.imageUrl} />
        {line.qty > 1 ? (
          <Text
            style={styles.qtyBadge}
            accessibilityLabel={`Số lượng ${line.qty}`}
          >
            {line.qty}
          </Text>
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.itemPrice}>
        {formatVnd(line.price * line.qty).replace('đ', '')}
      </Text>
    </View>
  );
});

/** The lines being paid for, two per row, each with its unit chooser. */
export function OrderList({ lines }: { lines: CartLine[] }) {
  return (
    <ScrollView
      accessibilityLabel="Món trong đơn"
      style={styles.items}
      contentContainerStyle={styles.itemsContent}
    >
      {lines.map((line) => (
        <View key={cartLineKey(line)} style={styles.cell}>
          <OrderItem line={line} />
          <UnitChooser line={line} />
        </View>
      ))}
    </ScrollView>
  );
}
