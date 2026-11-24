import { StyleSheet, View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import { strings } from './strings';

export type KhoSegment = 'products' | 'stock';

/** Sản phẩm / Tồn kho switch of the Kho tab; selecting never navigates by itself. */
export function StockSegment({
  selected,
  onSelect,
}: {
  selected: KhoSegment;
  onSelect: (segment: KhoSegment) => void;
}) {
  const t = useT(strings);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t('segments')}
      style={styles.segment}
    >
      {(['products', 'stock'] as const).map((item) => (
        <PressableScale
          key={item}
          accessibilityRole="radio"
          accessibilityLabel={t(item)}
          accessibilityState={{
            checked: selected === item,
            selected: selected === item,
          }}
          aria-checked={selected === item}
          aria-selected={selected === item}
          onPress={() => {
            if (selected !== item) onSelect(item);
          }}
          style={[styles.option, selected === item && styles.selected]}
        >
          <Text style={[styles.text, selected === item && styles.selectedText]}>
            {t(item)}
          </Text>
        </PressableScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    padding: space[1],
    alignSelf: 'flex-start',
    marginHorizontal: space[4],
    gap: space[1],
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.full,
  },
  option: {
    minHeight: size.tapMin,
    paddingHorizontal: space[6],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  selected: { backgroundColor: colors.ink },
  text: { ...typography.label, color: colors.ink },
  selectedText: { color: colors.onInk },
});
