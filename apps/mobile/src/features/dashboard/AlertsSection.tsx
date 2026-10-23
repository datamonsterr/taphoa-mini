import { router } from 'expo-router';
import { Box, Tag, TriangleAlert } from 'lucide-react-native';
import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlertPill, PressableScale, Text } from '@/components/ui';
import {
  useAlerts,
  useLowStockProducts,
  useManualLines,
  type ManualLine,
} from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space, typography } from '@/theme';

import { dashboardStrings } from './strings';

type Open = 'price' | 'manual' | null;

/** Low stock, price below cost and sold-without-catalog pills; the last two expand a list. */
export const AlertsSection = memo(function AlertsSection() {
  const t = useT(dashboardStrings);
  const [open, setOpen] = useState<Open>(null);
  const lowStock = useLowStockProducts();
  const margin = useAlerts('open');
  const manual = useManualLines('open');

  const toLowStock = useCallback(
    () => router.push({ pathname: '/inventory', params: { filter: 'low' } }),
    [],
  );
  const enrollLine = useCallback((line: ManualLine) => {
    router.push({
      pathname: '/enroll',
      params: {
        manualLineId: line.line_id,
        price: String(line.unit_price),
        ...(line.manual_label ? { name: line.manual_label } : {}),
        ...(line.crop_image ? { cropUrl: line.crop_image.url } : {}),
      },
    });
  }, []);
  const togglePrice = useCallback(
    () => setOpen((current) => (current === 'price' ? null : 'price')),
    [],
  );
  const toggleManual = useCallback(
    () => setOpen((current) => (current === 'manual' ? null : 'manual')),
    [],
  );

  if (lowStock.isError || margin.isError || manual.isError) {
    return (
      <View style={styles.errorRow}>
        <Text style={styles.errorText}>{t('alertsError')}</Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${t('alertsError')}, ${t('retry')}`}
          pressedScale={0.96}
          onPress={() => {
            void lowStock.refetch();
            void margin.refetch();
            void manual.refetch();
          }}
          style={styles.retry}
        >
          <Text style={styles.retryText}>{t('retry')}</Text>
        </PressableScale>
      </View>
    );
  }

  if (lowStock.isPending || margin.isPending || manual.isPending) {
    return (
      <View testID="alerts-skeleton" style={styles.row}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.skeleton} />
        ))}
      </View>
    );
  }

  const marginAlerts = margin.data;
  const manualLines = manual.data.items;

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <AlertPill
          count={lowStock.data.length}
          label={t('lowStock')}
          icon={Box}
          onPress={toLowStock}
        />
        <AlertPill
          count={marginAlerts.length}
          label={t('belowCost')}
          icon={TriangleAlert}
          onPress={togglePrice}
        />
        <AlertPill
          count={manualLines.length}
          label={t('noCatalog')}
          icon={Tag}
          tone="neutral"
          onPress={toggleManual}
        />
      </View>
      {open === 'price' ? (
        <View style={styles.list}>
          {marginAlerts.map((alert) => (
            <PressableScale
              key={alert.id}
              accessibilityRole="button"
              accessibilityLabel={alert.product_name ?? alert.product_id}
              pressedScale={0.98}
              onPress={() => router.push(`/product/${alert.product_id}`)}
              style={styles.item}
            >
              <Text style={styles.itemName} numberOfLines={1}>
                {alert.product_name}
              </Text>
              <Text style={styles.itemMeta}>
                {t('sellPrice')} {formatVnd(alert.selling_price)} ·{' '}
                {t('costPrice')} {formatVnd(alert.cost_price)}
              </Text>
            </PressableScale>
          ))}
        </View>
      ) : null}
      {open === 'manual' ? (
        <View style={styles.list}>
          {manualLines.map((line) => (
            <PressableScale
              key={line.line_id}
              accessibilityRole="button"
              accessibilityLabel={`${line.manual_label ?? t('manualItem')} × ${line.quantity}, ${formatVnd(line.unit_price)}`}
              pressedScale={0.98}
              onPress={() => enrollLine(line)}
              style={styles.item}
            >
              <Text style={styles.itemName} numberOfLines={1}>
                {line.manual_label ?? t('manualItem')} × {line.quantity}
              </Text>
              <Text style={styles.itemMeta}>{formatVnd(line.unit_price)}</Text>
            </PressableScale>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  section: { gap: space[3] },
  row: { flexDirection: 'row', gap: space[3] },
  skeleton: {
    flex: 1,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  list: {
    padding: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  item: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  itemName: { ...typography.label, color: colors.ink },
  itemMeta: { ...typography.caption, color: colors.inkMuted },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  errorText: { ...typography.caption, color: colors.danger, flex: 1 },
  retry: {
    minHeight: 48,
    paddingHorizontal: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  retryText: {
    fontFamily: fontFamily.semibold,
    fontSize: 17,
    color: colors.ink,
  },
});
