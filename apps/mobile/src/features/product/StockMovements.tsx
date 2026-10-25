import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import { useStockMovements } from '@/lib/api/hooks';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, space, typography } from '@/theme';

import { fill, strings } from './strings';

export function StockMovements({ productId }: { productId: string }) {
  const t = useT(strings);
  const language = useSettingsStore((s) => s.language);
  const movements = useStockMovements(productId);
  const formatDate = (date: string) =>
    new Date(date).toLocaleString(language === 'vi' ? 'vi-VN' : 'en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <View style={styles.list}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('movements')}
      </Text>
      {movements.isError ? (
        <View style={styles.list}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('movementsError')}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('movementsRetry')}
            onPress={() => void movements.refetch()}
            style={styles.retry}
          >
            <Text>{t('movementsRetry')}</Text>
          </PressableScale>
        </View>
      ) : null}
      {movements.data ? (
        movements.data.length ? (
          movements.data.map((movement) => (
            <View key={movement.id} style={styles.row}>
              <View style={styles.detail}>
                <Text style={styles.label}>
                  {t(`reason.${movement.reason}`)}
                </Text>
                <Text>
                  {fill(t('remaining'), { n: movement.quantity_after })}
                </Text>
                <Text style={styles.date}>
                  {formatDate(movement.created_at)}
                </Text>
                {movement.note ? <Text>{movement.note}</Text> : null}
              </View>
              <Text
                style={[
                  styles.delta,
                  {
                    color: movement.delta < 0 ? colors.danger : colors.success,
                  },
                ]}
              >
                {movement.delta > 0 ? '+' : ''}
                {movement.delta}
              </Text>
            </View>
          ))
        ) : (
          <Text>{t('movementsEmpty')}</Text>
        )
      ) : !movements.isError ? (
        <ActivityIndicator accessibilityLabel={t('movementsLoading')} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  list: { gap: space[3] },
  title: { ...typography.heading, color: colors.ink },
  row: {
    flexDirection: 'row',
    gap: space[3],
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.surfacePressed,
  },
  detail: { flex: 1, gap: space[1] },
  label: { ...typography.label, color: colors.ink },
  date: { ...typography.caption, color: colors.inkMuted },
  delta: { ...typography.heading, fontVariant: ['tabular-nums'] },
  retry: { minHeight: 56, justifyContent: 'center' },
  error: { color: colors.danger },
});
