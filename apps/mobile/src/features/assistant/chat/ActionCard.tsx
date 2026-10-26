import { useQueryClient } from '@tanstack/react-query';
import type { AssistantAction } from '@taphoa/api-client';
import * as Haptics from 'expo-haptics';
import { memo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { getApiClient } from '@/lib/api/client';
import { isApiError, unwrap } from '@/lib/api/errors';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space, typography } from '@/theme';

import {
  assistantKeys,
  useConfirmAssistantAction,
  useRejectAssistantAction,
  type AssistantThreadDetail,
} from '../api';
import { dict } from '../strings';

const badge: Record<
  AssistantAction['status'],
  { key: string; bg: string; fg: string }
> = {
  proposed: { key: 'actionProposed', bg: colors.accentSoft, fg: colors.accent },
  executing: {
    key: 'actionExecuting',
    bg: colors.warningSoft,
    fg: colors.warning,
  },
  done: { key: 'actionDone', bg: colors.successSoft, fg: colors.success },
  failed: { key: 'actionFailed', bg: colors.dangerSoft, fg: colors.danger },
  rejected: {
    key: 'actionRejected',
    bg: colors.surfacePressed,
    fg: colors.inkMuted,
  },
  expired: {
    key: 'actionExpired',
    bg: colors.surfacePressed,
    fg: colors.inkMuted,
  },
};

/** Proposed write with Confirm / Reject. The server decides; the card shows what it returns. */
export const ActionCard = memo(function ActionCard({
  action,
  onUpdate,
}: {
  action: AssistantAction;
  onUpdate: (action: AssistantAction) => void;
}) {
  const t = useT(dict);
  const queryClient = useQueryClient();
  const confirm = useConfirmAssistantAction();
  const reject = useRejectAssistantAction();
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  const status = stale ? 'expired' : action.status;
  const pending = confirm.isPending || reject.isPending;
  const look = badge[status];

  /** Someone else decided first: take the stored state of the action. */
  const syncDecided = async () => {
    const detail = await queryClient.fetchQuery({
      queryKey: assistantKeys.thread(action.thread_id),
      staleTime: 0,
      queryFn: () =>
        unwrap(
          getApiClient().raw.GET('/v1/assistant/threads/{threadId}', {
            params: { path: { threadId: action.thread_id } },
          }),
        ),
    });
    const fresh = (detail as AssistantThreadDetail).actions.find(
      (a) => a.id === action.id,
    );
    if (fresh) onUpdate(fresh);
    else setFailed(true);
  };

  const decide = async (kind: 'confirm' | 'reject') => {
    setFailed(false);
    try {
      const result = await (kind === 'confirm' ? confirm : reject).mutateAsync(
        action.id,
      );
      if (kind === 'confirm')
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      onUpdate(result);
    } catch (error) {
      if (isApiError(error) && error.code === 'action_stale') setStale(true);
      else if (isApiError(error) && error.code === 'already_decided')
        await syncDecided().catch(() => setFailed(true));
      else setFailed(true);
    }
  };

  return (
    <View style={styles.card} testID="action-card">
      <Text style={styles.summary}>{action.summary_vi}</Text>
      <View style={[styles.badge, { backgroundColor: look.bg }]}>
        <Text style={[styles.badgeText, { color: look.fg }]}>
          {t(look.key)}
        </Text>
      </View>
      {status === 'proposed' ? (
        <View style={styles.buttons}>
          <PressableScale
            testID="action-confirm"
            accessibilityRole="button"
            accessibilityLabel={t('confirm')}
            accessibilityState={{ disabled: pending, busy: confirm.isPending }}
            disabled={pending}
            onPress={() => void decide('confirm')}
            style={[styles.button, styles.confirm, pending && styles.disabled]}
          >
            <Text style={styles.confirmText}>{t('confirm')}</Text>
          </PressableScale>
          <PressableScale
            testID="action-reject"
            accessibilityRole="button"
            accessibilityLabel={t('reject')}
            accessibilityState={{ disabled: pending, busy: reject.isPending }}
            disabled={pending}
            onPress={() => void decide('reject')}
            style={[styles.button, styles.reject, pending && styles.disabled]}
          >
            <Text style={styles.rejectText}>{t('reject')}</Text>
          </PressableScale>
        </View>
      ) : null}
      {failed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('actionError')}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: space[3],
    padding: space[4],
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.accentSoft,
    backgroundColor: colors.surface,
  },
  summary: { ...typography.label, color: colors.ink },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
  },
  badgeText: typography.caption,
  buttons: { flexDirection: 'row', gap: space[3] },
  button: {
    flex: 1,
    minHeight: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  confirm: { backgroundColor: colors.ink },
  confirmText: { ...typography.label, color: colors.onInk },
  reject: { backgroundColor: colors.surfaceSoft },
  rejectText: { ...typography.label, color: colors.ink },
  disabled: { opacity: 0.4 },
  error: { ...typography.caption, color: colors.danger },
});
