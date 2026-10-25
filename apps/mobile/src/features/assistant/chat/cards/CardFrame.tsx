import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import { colors, radius, space, typography } from '@/theme';

/** Shared look of the structured cards: soft surface, a heading, then rows. */
export function CardFrame({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export const cardStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  grow: { flex: 1 },
  name: { ...typography.label, color: colors.ink },
  sub: { ...typography.caption, color: colors.inkMuted },
  value: { ...typography.label, color: colors.ink },
});

const styles = StyleSheet.create({
  card: {
    gap: space[3],
    padding: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  title: { ...typography.caption, color: colors.inkMuted },
});
