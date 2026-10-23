import { ChevronRight, Tag } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { formatVnd } from '@/lib/format';
import { camera, colors, radius } from '@/theme';
import { fontFamily } from '@/theme/typography';

type Props =
  | {
      id: string;
      variant: 'selected' | 'deselected';
      price: number;
      name: string;
      /** True while the alternatives strip is open for this box. */
      expanded?: boolean;
      onPress: (id: string) => void;
    }
  | { id: string; variant: 'unknown'; onPress: (id: string) => void };

/** Price chip on the box's bottom edge. Tap opens the strip, or enroll when unknown. */
export const PricePill = memo(function PricePill(props: Props) {
  const { id, onPress } = props;
  const press = useCallback(() => onPress(id), [onPress, id]);
  if (props.variant === 'unknown') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Chưa có trong kho, nhập giá"
        onPress={press}
        style={[styles.pill, styles.unknown]}
      >
        <Icon icon={Tag} size={18} strokeWidth={3} color={colors.warning} />
        <Text style={[styles.text, styles.unknownText]}>?</Text>
      </Pressable>
    );
  }

  const selected = props.variant === 'selected';
  const tint = selected ? colors.ink : camera.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.name} ${formatVnd(props.price)}, xem món khác`}
      accessibilityState={{ expanded: !!props.expanded }}
      aria-expanded={!!props.expanded}
      onPress={press}
      style={[styles.pill, selected ? styles.selected : styles.deselected]}
    >
      <Text style={[styles.text, { color: tint }]}>
        {formatVnd(props.price).replace('đ', '')}
      </Text>
      <Icon icon={ChevronRight} size={16} strokeWidth={3} color={tint} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pill: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: radius.full,
    boxShadow: `0 4px 14px ${camera.shadow}59`,
  },
  selected: { backgroundColor: camera.white },
  deselected: { backgroundColor: camera.pillDark },
  unknown: {
    justifyContent: 'center',
    gap: 6,
    height: 44,
    paddingHorizontal: 16,
    backgroundColor: colors.warningSoft,
  },
  text: {
    fontFamily: fontFamily.extrabold,
    fontSize: 18,
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
  unknownText: { fontSize: 20, lineHeight: 24, color: colors.warning },
});
