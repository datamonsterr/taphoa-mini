import { router, type Href } from 'expo-router';
import { Tag, TriangleAlert } from 'lucide-react-native';
import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlertPill, PressableScale, Text } from '@/components/ui';
import { useAlerts, useManualLines, type ManualLine } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { selectIsLead, useSessionStore } from '@/stores/session';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, size, space, typography } from '@/theme';
import { useLowStockItems } from '@/features/stock-alerts/useLowStockItems';

import { dashboardStrings } from './strings';

type Open = 'price' | 'manual' | null;

/** Price below cost and sold-without-catalog pills (Lead only); each expands a list. */
const LeadAlerts = memo(function LeadAlerts() {
  const t = useT(dashboardStrings);
  const [open, setOpen] = useState<Open>(null);
  // Margin alerts and the review queue are Lead-only: a Seller's request would answer 403.
  const isLead = useSessionStore(selectIsLead);
  const margin = useAlerts('open', isLead);
  const manual = useManualLines('open', isLead);

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

  if (margin.isError || manual.isError) {
    return (
      <View style={styles.errorRow}>
        <Text style={styles.errorText}>{t('alertsError')}</Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${t('alertsError')}, ${t('retry')}`}
          pressedScale={0.96}
          onPress={() => {
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

  // A Seller has no alert to see: the margin and review requests are the Lead's.
  if (!isLead) return null;

  if (margin.isPending || manual.isPending) {
    return (
      <View testID="alerts-skeleton" style={styles.row}>
        {[0, 1].map((i) => (
          <View key={i} style={styles.skeleton} />
        ))}
      </View>
    );
  }

  const marginAlerts = margin.data ?? [];
  const manualLines = manual.data?.items ?? [];

  return (
    <View style={styles.section}>
      <View style={styles.row}>
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

/** Stock is visible to every member, independently of the Lead-only review queue. */
export const AlertsSection = memo(function AlertsSection() {
  const t = useT(dashboardStrings);
  const { low, out, items } = useLowStockItems();
  const isError = low.isError || out.isError;
  const isPending = low.isPending || out.isPending;
  return (
    <View style={styles.section}>
      {isError ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{t('stockError')}</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${t('stockError')}, ${t('retry')}`}
            onPress={() => {
              void low.refetch();
              void out.refetch();
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : isPending ? (
        <View
          testID="stock-alerts-skeleton"
          accessibilityLabel={t('loading')}
          style={styles.skeleton}
        />
      ) : items.length ? (
        <View style={styles.stockSection}>
          <View style={styles.stockHeader}>
            <Text accessibilityRole="header" style={styles.stockTitle}>
              {t('lowStock')}
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('viewAll')}
              onPress={() => router.push('/stock' as Href)}
              style={styles.retry}
            >
              <Text style={styles.retryText}>{t('viewAll')}</Text>
            </PressableScale>
          </View>
          <View style={styles.list}>
            {items.slice(0, 5).map((item) => (
              <View key={item.product_id} style={styles.item}>
                <Text style={styles.itemName} numberOfLines={1}>
                  {item.name ?? t('unnamedProduct')}
                </Text>
                <Text
                  style={[
                    styles.itemMeta,
                    {
                      color:
                        item.status === 'out' ? colors.danger : colors.warning,
                    },
                  ]}
                >
                  {t(item.status === 'out' ? 'outOfStock' : 'stockLow')} ·{' '}
                  {item.stock_quantity} {t('remaining')}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      <LeadAlerts />
    </View>
  );
});

const styles = StyleSheet.create({
  stockSection: { gap: space[2] },
  stockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  stockTitle: { ...typography.heading, color: colors.ink, flexShrink: 1 },
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
    minHeight: size.tapMin,
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
