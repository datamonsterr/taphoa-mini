import type { ErrorBoundaryProps } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import { routeErrorStrings } from './strings';

const CHUNK_FAILURE =
  /loading (module|chunk)|chunkloaderror|dynamically imported module|importing a module script failed|failed to fetch|network request failed|load failed/i;

/** Whether a screen failed to load its code (a lost network, a build that was replaced). */
export function isLoadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === 'ChunkLoadError' ||
    (typeof message === 'string' && CHUNK_FAILURE.test(message))
  );
}

/**
 * Root `ErrorBoundary` of the router. Without it a route whose JavaScript chunk cannot be
 * fetched (web exports one chunk per route) unmounts the whole app and leaves a blank page.
 * It uses no provider and no animation: it must render when the tree above it is gone.
 * A failed chunk import stays rejected for the life of the page, so the web retry reloads.
 */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useT(routeErrorStrings);
  const load = isLoadFailure(error);
  const onRetry = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined')
      window.location.reload();
    else void retry();
  };
  return (
    <View testID="route-error" accessibilityRole="alert" style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {t(load ? 'loadTitle' : 'crashTitle')}
      </Text>
      <Text style={styles.message}>
        {t(load ? 'loadMessage' : 'crashMessage')}
      </Text>
      <Pressable
        testID="route-error-retry"
        accessibilityRole="button"
        accessibilityLabel={t('retry')}
        onPress={onRetry}
        style={styles.button}
      >
        <Text style={styles.buttonText}>{t('retry')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
    padding: space[6],
    backgroundColor: colors.surface,
  },
  title: { ...typography.title, color: colors.ink, textAlign: 'center' },
  message: { ...typography.body, color: colors.inkMuted, textAlign: 'center' },
  button: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space[6],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  buttonText: { ...typography.label, color: colors.onInk },
});
