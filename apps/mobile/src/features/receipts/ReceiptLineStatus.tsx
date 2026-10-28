import { Check, TriangleAlert } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';
import { strings } from './strings';

export function receiptLineStatus(productId: string | null, price?: number) {
  if (!productId) return 'pick';
  return price && price > 0 ? 'matched' : 'price';
}

export function ReceiptLineStatus({
  productId,
  price,
}: {
  productId: string | null;
  price?: number;
}) {
  const t = useT(strings);
  const status = receiptLineStatus(productId, price);
  const matched = status === 'matched';
  const color = matched ? colors.success : colors.warning;
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: matched ? colors.successSoft : colors.warningSoft },
      ]}
    >
      <Icon icon={matched ? Check : TriangleAlert} size={18} color={color} />
      <Text style={[typography.caption, { color }]}>
        {t(
          status === 'pick'
            ? 'picker'
            : status === 'price'
              ? 'unknownPrice'
              : 'matched',
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space[1],
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
  },
});
