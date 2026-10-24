import { router, type Href } from 'expo-router';
import { TriangleAlert, X } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { colors, radius, size, space, typography } from '@/theme';

import { stockAlertStrings } from './strings';

export function LowStockBanner() {
  const alerts = useLowStockAlerts((s) => s.alerts);
  const clear = useLowStockAlerts((s) => s.clear);
  const t = useT(stockAlertStrings);
  const first = alerts[0];
  if (!first) return null;
  const message =
    alerts.length === 1
      ? fill(t('single'), {
          name: first.name ?? t('unnamed'),
          quantity: first.stock_quantity,
        })
      : fill(t('multiple'), { count: alerts.length });

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.banner}>
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel={message}
          accessibilityHint={t('openStock')}
          accessibilityLiveRegion="polite"
          onAccessibilityTap={() => router.push('/stock' as Href)}
          style={styles.message}
        >
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={message}
            onPress={() => router.push('/stock' as Href)}
            style={styles.link}
          >
            <Icon icon={TriangleAlert} color={colors.warning} />
            <Text style={styles.text}>{message}</Text>
          </PressableScale>
        </View>
        <CircleButton
          icon={X}
          accessibilityLabel={t('dismiss')}
          onPress={clear}
          iconColor={colors.warning}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.surface },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[2],
    marginHorizontal: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
  },
  message: { flex: 1 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: size.tapMin,
    paddingHorizontal: space[2],
  },
  text: { ...typography.caption, color: colors.warning, flex: 1 },
});
