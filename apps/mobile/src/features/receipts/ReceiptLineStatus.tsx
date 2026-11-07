import { Check } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';
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
      {matched ? <Icon icon={Check} size={14} color={color} /> : null}
      <Text style={[styles.text, { color }]}>
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
    flexShrink: 0,
    gap: space[1],
    height: 26,
    paddingHorizontal: space[3],
    borderRadius: radius.full,
  },
  // Board 19b: a 26px badge with 13px text, on the same row as the product name.
  text: { fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 18 },
});
