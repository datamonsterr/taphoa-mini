import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { debtStrings } from './strings';

/** "Quá hạn 9 ngày": the oldest unsettled credit is more than seven days old. */
export function OverdueBadge({ days }: { days: number }) {
  const t = useT(debtStrings);
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{fill(t('book.badge'), { days })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.warningSoft,
  },
  text: { ...typography.caption, color: colors.warning },
});
