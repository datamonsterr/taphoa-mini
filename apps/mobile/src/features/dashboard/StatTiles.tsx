import {
  Banknote,
  DollarSign,
  ArrowUpRight,
  QrCode,
  ReceiptText,
  TrendingUp,
} from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, MoneyText, Text } from '@/components/ui';
import { formatVnd } from '@/lib/format';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import type { DashboardTotals } from './useDashboardData';

type Labels = {
  revenue: string;
  orders: string;
  cash: string;
  transfer: string;
  expense: string;
  net: string;
};

type Props = { totals: DashboardTotals; labels: Labels };

/** Revenue (wide, ink) plus cash, transfer, expense and net tiles. */
export const StatTiles = memo(function StatTiles({ totals, labels }: Props) {
  const loss = totals.net < 0;
  return (
    <View style={styles.grid}>
      <View
        accessible
        accessibilityLabel={`${labels.revenue} ${formatVnd(totals.revenue)}, ${totals.salesCount} ${labels.orders}`}
        style={[styles.tile, styles.wide]}
      >
        <View style={styles.wideTop}>
          <Icon icon={TrendingUp} color={colors.onInk} />
          <View style={styles.count}>
            <Icon icon={ReceiptText} size={20} color={colors.onInk} />
            <Text style={styles.countText}>{totals.salesCount}</Text>
          </View>
        </View>
        <MoneyText
          amount={totals.revenue}
          variant="total"
          color={colors.onInk}
          style={styles.revenue}
        />
      </View>
      <Tile
        icon={Banknote}
        iconColor={colors.inkMuted}
        label={labels.cash}
        amount={totals.cash}
      />
      <Tile
        icon={QrCode}
        iconColor={colors.inkMuted}
        label={labels.transfer}
        amount={totals.transfer}
      />
      <Tile
        icon={ArrowUpRight}
        iconColor={colors.danger}
        label={labels.expense}
        amount={totals.expense}
        prefix="−"
        background={colors.dangerSoft}
        color={colors.danger}
      />
      <Tile
        icon={DollarSign}
        label={labels.net}
        amount={totals.net}
        iconColor={loss ? colors.danger : colors.success}
        background={loss ? colors.dangerSoft : colors.successSoft}
        color={loss ? colors.danger : colors.success}
      />
    </View>
  );
});

type TileProps = {
  icon: typeof Banknote;
  iconColor: string;
  label: string;
  amount: number;
  prefix?: string;
  background?: string;
  color?: string;
};

const Tile = memo(function Tile({
  icon,
  iconColor,
  label,
  amount,
  prefix = '',
  background,
  color = colors.ink,
}: TileProps) {
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${formatVnd(amount)}`}
      style={[
        styles.tile,
        styles.half,
        background ? { backgroundColor: background } : null,
      ]}
    >
      <View style={styles.tileIcon}>
        <Icon icon={icon} color={iconColor} />
      </View>
      <Text style={[styles.amount, { color }]} numberOfLines={1}>
        {prefix}
        {formatVnd(amount)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  tile: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  wide: { width: '100%', backgroundColor: colors.ink },
  // Two columns with a 12px gap: (358 - 12) / 2.
  half: { flexGrow: 1, flexBasis: '45%' },
  // Board: icon sits in a 33px line box (inline svg + descender gap).
  tileIcon: { height: 33 },
  wideTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  count: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countText: {
    fontFamily: fontFamily.semibold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.onInk,
    fontVariant: ['tabular-nums'],
  },
  revenue: { ...typography.total, fontSize: 40, lineHeight: 46, marginTop: 4 },
  amount: {
    marginTop: 4,
    fontFamily: fontFamily.extrabold,
    fontSize: 22,
    lineHeight: 28,
    fontVariant: ['tabular-nums'],
  },
});
