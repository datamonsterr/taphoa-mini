import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { strings } from './strings';

export function StockSegment({ selected }: { selected: 'products' | 'stock' }) {
  const t = useT(strings);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t('stock')}
      style={styles.segment}
    >
      {(['products', 'stock'] as const).map((item) => (
        <PressableScale
          key={item}
          accessibilityRole="radio"
          accessibilityLabel={t(item)}
          accessibilityState={{ checked: selected === item }}
          onPress={() => {
            if (selected === item) return;
            if (item === 'stock') router.push('/stock');
            else router.replace('/inventory');
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
    marginHorizontal: space[4],
    gap: space[1],
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.full,
  },
  option: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  selected: { backgroundColor: colors.ink },
  text: { ...typography.label, color: colors.ink },
  selectedText: { color: colors.onInk },
});
