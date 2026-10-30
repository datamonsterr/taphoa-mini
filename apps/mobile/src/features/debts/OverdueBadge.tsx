import { Clock } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { debtStrings } from './strings';

type Props =
  { days: number; compact?: never } | { compact: true; days?: never };

/**
 * Board pill: Quá hạn 12 ngày with a clock on the customer screen, and the short Quá hạn on a
 * debt book row (the age sits above it). The oldest unsettled credit is more than seven days old.
 */
export function OverdueBadge(props: Props) {
  const t = useT(debtStrings);
  const compact = props.compact === true;
  const text = compact
    ? t('book.badgeShort')
    : fill(t('book.badge'), { days: props.days });
  return (
    <View style={[styles.badge, compact && styles.compact]}>
      {compact ? null : <Icon icon={Clock} size={18} color={colors.danger} />}
      <Text style={[styles.text, compact && styles.compactText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.dangerSoft,
  },
  compact: { height: 26, paddingVertical: 0, justifyContent: 'center' },
  text: {
    ...typography.caption,
    fontFamily: fontFamily.semibold,
    color: colors.danger,
  },
  compactText: { fontSize: 13, lineHeight: 16 },
});
