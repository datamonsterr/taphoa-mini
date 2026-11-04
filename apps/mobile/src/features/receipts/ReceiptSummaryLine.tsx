import { Image } from 'expo-image';
import {
  Check,
  ChevronRight,
  Package,
  TriangleAlert,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { useProduct } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';
import { strings } from './strings';

export type SummaryLine = {
  name: string;
  quantity: number;
  unitPrice: number;
  productId: string | null;
};

/**
 * One line of the import receipt summary (board 19): product photo, the name read from the
 * receipt, "quantity unit × price", and either the matched product or an orange "Chọn sản phẩm"
 * action. An unmatched line stays in the list so the owner can fix it where it is named.
 */
export function ReceiptSummaryLine({
  line,
  total,
  readonly,
  disabled,
  first,
  onPick,
}: {
  line: SummaryLine;
  total: number;
  readonly: boolean;
  disabled: boolean;
  first: boolean;
  onPick: () => void;
}) {
  const t = useT(strings);
  const product = useProduct(line.productId ?? undefined);
  const matched = line.productId !== null;
  const unit = product.data?.base_unit;
  const imageUri = product.data?.images[0]?.url;
  return (
    <View
      testID="receipt-summary-line"
      style={[
        styles.line,
        matched ? !first && styles.divider : styles.unmatched,
      ]}
    >
      <View style={[styles.photo, !matched && styles.photoWarn]}>
        <Icon
          icon={matched ? Package : TriangleAlert}
          color={matched ? colors.inkMuted : colors.warning}
        />
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            contentFit="cover"
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </View>
      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.name}>
          {line.name}
        </Text>
        <Text numberOfLines={1} style={styles.amounts}>
          {`${line.quantity}${unit ? ` ${unit}` : ''} × ${formatVnd(line.unitPrice)}`}
        </Text>
        {matched ? (
          <View style={[styles.badge, styles.badgeOk]}>
            <Icon icon={Check} size={14} color={colors.success} />
            <Text
              numberOfLines={1}
              style={[styles.badgeText, { color: colors.success }]}
            >
              {product.data?.name ?? line.name}
            </Text>
          </View>
        ) : readonly ? (
          <View style={[styles.badge, styles.badgeWarn]}>
            <Text style={[styles.badgeText, { color: colors.warning }]}>
              {t('unmatched')}
            </Text>
          </View>
        ) : (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${t('picker')}: ${line.name}`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={12}
            onPress={onPick}
            style={[styles.badge, styles.badgeWarn]}
          >
            <Text style={[styles.badgeText, { color: colors.warning }]}>
              {t('picker')}
            </Text>
            <Icon icon={ChevronRight} size={14} color={colors.warning} />
          </PressableScale>
        )}
      </View>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        accessibilityLabel={`${t('cost')}: ${line.name}`}
        style={styles.total}
      >
        {formatVnd(total)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[2],
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.surfacePressed },
  unmatched: {
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
  },
  photo: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  photoWarn: { backgroundColor: colors.surface },
  image: { width: '100%', height: '100%' },
  body: { flex: 1, minWidth: 0, gap: 2, alignItems: 'flex-start' },
  name: { fontFamily: fontFamily.semibold, fontSize: 18, lineHeight: 24 },
  amounts: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 16,
    color: colors.inkMuted,
    fontVariant: ['tabular-nums'],
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    gap: space[1],
    height: 24,
    marginTop: 2,
    paddingHorizontal: space[3] - 2,
    borderRadius: radius.full,
  },
  badgeOk: { backgroundColor: colors.successSoft },
  badgeWarn: { backgroundColor: colors.warningSoft },
  badgeText: { fontFamily: fontFamily.semibold, fontSize: 12, lineHeight: 16 },
  total: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    lineHeight: 26,
    flexShrink: 1,
    maxWidth: 120,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
