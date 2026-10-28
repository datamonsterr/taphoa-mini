import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale, Text } from '@/components/ui';
import { fill, useT } from '@/lib/i18n';
import { useOnline } from '@/lib/online';
import {
  discardOutboxItem,
  retryOutboxItem,
  useOutboxStore,
  type OutboxItem,
} from '@/lib/outbox';
import { saleCode } from '@/lib/uuid';
import { colors, radius, size, space, typography } from '@/theme';

import { syncStrings } from './syncStrings';

const openGrid = () => router.push('/inventory');

/**
 * Overlay above the camera route: the offline hint that points to the grid (recognition needs the
 * server), the count of sales waiting in the outbox, and the first sale the server refused for
 * good, which the seller can discard or send again.
 */
export function SyncStatus() {
  const online = useOnline();
  const items = useOutboxStore((s) => s.items);
  if (online && items.length === 0) return null;
  return <Banner online={online} items={items} />;
}

function Banner({ online, items }: { online: boolean; items: OutboxItem[] }) {
  const t = useT(syncStrings);
  const insets = useSafeAreaInsets();
  const pending = items.filter((item) => item.status === 'pending').length;
  const failed = items.filter((item) => item.status === 'failed');
  const firstFailed = failed[0];
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { top: space[3] + insets.top }]}
    >
      {!online ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${t('offline')} ${t('openGrid')}`}
          onPress={openGrid}
          style={styles.card}
        >
          <Text style={styles.text}>{t('offline')}</Text>
          <Text style={styles.action}>{t('openGrid')}</Text>
        </PressableScale>
      ) : null}
      {pending > 0 ? (
        <View style={styles.card} accessibilityRole="summary">
          <Text style={styles.text}>{fill(t('pending'), { n: pending })}</Text>
        </View>
      ) : null}
      {firstFailed ? (
        <View accessible style={styles.card} accessibilityRole="alert">
          <Text style={styles.text}>
            {fill(t('failed'), { n: failed.length })}
          </Text>
          <Text style={styles.detail}>
            {fill(t('failedDetail'), {
              code: saleCode(firstFailed.key),
              message: firstFailed.error?.message ?? '',
            })}
          </Text>
          <View style={styles.row}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('retry')}
              onPress={() => retryOutboxItem(firstFailed.key)}
              style={styles.button}
            >
              <Text style={styles.action}>{t('retry')}</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('discard')}
              onPress={() => discardOutboxItem(firstFailed.key)}
              style={styles.button}
            >
              <Text style={styles.action}>{t('discard')}</Text>
            </PressableScale>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: space[4],
    right: space[4],
    gap: space[2],
  },
  card: {
    gap: space[1],
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  text: { ...typography.label, color: colors.ink },
  detail: { ...typography.caption, color: colors.inkMuted },
  action: { ...typography.label, color: colors.accent },
  row: { flexDirection: 'row', gap: space[3] },
  button: { minHeight: size.tapMin, justifyContent: 'center' },
});
