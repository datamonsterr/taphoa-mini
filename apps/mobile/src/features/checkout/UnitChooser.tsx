import { View } from 'react-native';
import { Text, PressableScale } from '@/components/ui';
import { useProduct } from '@/lib/api/hooks';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { unitStrings } from '@/features/product/unitStrings';
import { styles, Action } from '@/features/sales/kit';
import { cartLineKey, useCartStore, type CartLine } from '@/stores/cart';

/** Both cart and payment show choices: camera callers may open payment directly. */
export function UnitChooser({ line }: { line: CartLine }) {
  const query = useProduct(line.manual ? undefined : line.productId);
  const t = useT(unitStrings);
  const setUnit = useCartStore((s) => s.setUnit);
  if (line.manual) return null;
  if (query.isError)
    return (
      <View>
        <Text>{t('unavailable')}</Text>
        <Action label={t('retry')} onPress={() => void query.refetch()} />
      </View>
    );
  const product = query.data;
  if (!product?.units.length) return null;
  const units = [
    { id: undefined, name: product.base_unit, price: product.price },
    ...product.units,
  ];
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`${t('choose')} ${line.name}`}
      style={{ gap: 8 }}
    >
      {units.map((unit) => (
        <PressableScale
          key={unit.id ?? 'base'}
          accessibilityRole="radio"
          accessibilityLabel={`${unit.name}, ${formatVnd(unit.price)}, ${t('choose')}`}
          accessibilityState={{ checked: line.unitId === unit.id }}
          onPress={() => setUnit(cartLineKey(line), unit)}
          style={styles.card}
        >
          <Text>
            {line.unitId === unit.id ? '● ' : '○ '}
            {unit.name} · {formatVnd(unit.price)}
          </Text>
        </PressableScale>
      ))}
    </View>
  );
}
