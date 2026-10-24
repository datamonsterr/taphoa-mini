import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { create } from 'zustand';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';
import { strings } from './strings';

/** Survives closing the review route so the camera can announce the result. */
export const useReceiptNotice = create<{ count: number | null }>(() => ({
  count: null,
}));

export function ReceiptToast() {
  const insets = useSafeAreaInsets();
  const count = useReceiptNotice((s) => s.count);
  const t = useT(strings);
  useEffect(() => {
    if (count === null) return;
    const timer = setTimeout(
      () => useReceiptNotice.setState({ count: null }),
      4000,
    );
    return () => clearTimeout(timer);
  }, [count]);
  if (count === null) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.toast, { top: insets.top + space[4] }]}
    >
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={styles.text}
      >
        {fill(t('success'), { count })}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: space[4],
    right: space[4],
    top: space[4],
    padding: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
    zIndex: 20,
  },
  text: { ...typography.label, color: colors.success },
});
