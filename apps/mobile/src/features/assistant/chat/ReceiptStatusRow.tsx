import { router } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import type { ReceiptChatState } from '../receiptChat';
import { dict } from '../strings';

type Look = { key: string; bg: string; fg: string };

function look({ phase, failure }: ReceiptChatState): Look {
  switch (phase) {
    case 'creating_thread':
    case 'sending':
      return { key: 'receiptReading', bg: colors.accentSoft, fg: colors.ink };
    case 'reviewing':
      return { key: 'receiptReviewing', bg: colors.accentSoft, fg: colors.ink };
    case 'awaiting_confirm':
      return { key: 'receiptAwaiting', bg: colors.accentSoft, fg: colors.ink };
    case 'confirming':
      return {
        key: 'receiptConfirming',
        bg: colors.warningSoft,
        fg: colors.ink,
      };
    case 'confirmed':
      return {
        key: 'receiptConfirmed',
        bg: colors.successSoft,
        fg: colors.success,
      };
    case 'rejected':
      return {
        key: 'receiptRejected',
        bg: colors.surfacePressed,
        fg: colors.inkMuted,
      };
    case 'expired':
      return {
        key: 'receiptExpired',
        bg: colors.warningSoft,
        fg: colors.warning,
      };
    case 'failed':
      return {
        key: failure === 'action' ? 'receiptActionError' : 'receiptError',
        bg: colors.dangerSoft,
        fg: colors.danger,
      };
  }
}

/**
 * Compact status of a receipt thread above the messages. The link to the table form is always
 * there; a failure adds Retry.
 */
export const ReceiptStatusRow = memo(function ReceiptStatusRow({
  receiptId,
  state,
  onRetry,
}: {
  receiptId: string;
  state: ReceiptChatState;
  onRetry: () => void;
}) {
  const t = useT(dict);
  const { key, bg, fg } = look(state);
  const failed = state.phase === 'failed';
  return (
    <View testID="receipt-status" style={[styles.row, { backgroundColor: bg }]}>
      <Text
        accessibilityRole={failed ? 'alert' : undefined}
        accessibilityLiveRegion="polite"
        style={[styles.text, { color: fg }]}
      >
        {t(key)}
      </Text>
      <View style={styles.buttons}>
        {failed ? (
          <PressableScale
            testID="receipt-status-retry"
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            onPress={onRetry}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t('retry')}</Text>
          </PressableScale>
        ) : null}
        <PressableScale
          testID="receipt-status-table"
          accessibilityRole="button"
          accessibilityLabel={t('viewAsTable')}
          onPress={() => router.push(`/receipt/${receiptId}`)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t('viewAsTable')}</Text>
        </PressableScale>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingLeft: space[4],
    paddingRight: space[2],
    borderRadius: radius.md,
  },
  text: { ...typography.label, flexGrow: 1, flexShrink: 1, flexBasis: 160 },
  buttons: { flexDirection: 'row', alignItems: 'center' },
  button: {
    minHeight: size.tapMin,
    justifyContent: 'center',
    paddingHorizontal: space[3],
  },
  buttonText: { ...typography.label, color: colors.accent },
});
