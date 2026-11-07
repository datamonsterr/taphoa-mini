import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { statusErrorText } from '@/lib/api/errorText';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, radius, size, space, typography } from '@/theme';

import type { ChatError } from '../chatReducer';
import { dict } from '../strings';

/** Quota is a daily limit: retrying cannot help, so it has no Retry button. */
export const ErrorNotice = memo(function ErrorNotice({
  error,
  onRetry,
}: {
  error: ChatError;
  /** Without it the notice has no Retry button (a newer turn already retried). */
  onRetry?: () => void;
}) {
  const t = useT(dict);
  const language = useSettingsStore((s) => s.language);
  const serverText = language === 'vi' ? error.message : undefined;
  let text: string;
  switch (error.code) {
    case 'quota':
      text = serverText ?? t('quotaFallback');
      break;
    case 'network':
      text = t('networkError');
      break;
    case 'http':
      text = statusErrorText(error.status ?? 0, error.retryAfterMs, language);
      break;
    case 'busy':
      text = t('busyError');
      break;
    case 'interrupted':
      text = t('interruptedError');
      break;
    default:
      text = serverText ?? t('errorGeneric');
  }
  return (
    <View style={styles.box}>
      <Text accessibilityRole="alert" style={styles.text}>
        {text}
      </Text>
      {error.code === 'quota' || !onRetry ? null : (
        <PressableScale
          testID="assistant-retry"
          accessibilityRole="button"
          accessibilityLabel={t('retry')}
          onPress={onRetry}
          style={styles.retry}
        >
          <Text style={styles.retryText}>{t('retry')}</Text>
        </PressableScale>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    gap: space[2],
    padding: space[3],
    borderRadius: radius.sm,
    backgroundColor: colors.dangerSoft,
  },
  text: { ...typography.body, color: colors.danger },
  retry: {
    minHeight: size.tapMin,
    minWidth: size.tapMin,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.danger,
  },
  retryText: { ...typography.label, color: colors.onInk },
});
