import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PressableScale, Text } from '@/components/ui';
import { useMembers, usePriceHistory } from '@/lib/api/hooks';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, space, typography } from '@/theme';

import { strings } from './strings';

export function PriceHistory({ productId }: { productId: string }) {
  const t = useT(strings);
  const language = useSettingsStore((s) => s.language);
  const history = usePriceHistory(productId);
  const members = useMembers();
  const price = (value: number | null | undefined) =>
    value == null ? t('historyNone') : formatVnd(value);
  return (
    <View style={styles.list}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('history')}
      </Text>
      {history.isError ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('historyError')}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('historyRetry')}
            onPress={() => void history.refetch()}
            style={styles.button}
          >
            <Text>{t('historyRetry')}</Text>
          </PressableScale>
        </View>
      ) : null}
      {history.data ? (
        history.data.length ? (
          history.data.map((change) => (
            <View key={change.id} style={styles.row}>
              <Text>
                {t(
                  change.field === 'cost_price'
                    ? 'historyCost'
                    : change.field === 'unit_price'
                      ? 'historyUnit'
                      : 'historyPrice',
                )}
              </Text>
              <Text style={styles.label}>
                {price(change.old_value)} → {price(change.new_value)}
              </Text>
              <Text>
                {members.data?.find((m) => m.id === change.changed_by)
                  ?.display_name ?? t('historyUnknown')}
              </Text>
              <Text>
                {new Date(change.changed_at).toLocaleString(
                  language === 'vi' ? 'vi-VN' : 'en-GB',
                  {
                    timeZone: 'Asia/Ho_Chi_Minh',
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  },
                )}
              </Text>
            </View>
          ))
        ) : (
          <Text>{t('historyEmpty')}</Text>
        )
      ) : !history.isError ? (
        <ActivityIndicator accessibilityLabel={t('historyLoading')} />
      ) : null}
      {history.hasNextPage ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('historyMore')}
          onPress={() => void history.fetchNextPage()}
          style={styles.button}
        >
          <Text>{t('historyMore')}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  list: { gap: space[3] },
  title: { ...typography.heading, color: colors.ink },
  row: {
    gap: space[1],
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.surfacePressed,
  },
  label: { ...typography.label, color: colors.ink },
  error: { color: colors.danger },
  button: { minHeight: 56, justifyContent: 'center' },
});
