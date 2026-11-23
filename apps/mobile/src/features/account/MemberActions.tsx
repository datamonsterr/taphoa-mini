import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale, ScaledText } from '@/components/ui';
import {
  apiErrorText,
  isApiError,
  useRemoveMember,
  useUpdateMember,
  type Member,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, radius, space } from '@/theme';

import { fill, strings } from './strings';

type Pending = { kind: 'role' | 'remove'; member: Member };

export type MemberActionsProps = {
  members: Member[] | undefined;
  roleLabel: (role: Member['role']) => string;
};

/** Lead-only part of the people section: change a member's role or remove them, each confirmed first. */
export const MemberActions = memo(function MemberActions({
  members,
  roleLabel,
}: MemberActionsProps) {
  const t = useT(strings);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateMember();
  const remove = useRemoveMember();
  const busy = update.isPending || remove.isPending;

  const ask = useCallback((next: Pending) => {
    setError(null);
    setPending(next);
  }, []);
  const cancel = useCallback(() => setPending(null), []);
  const confirm = useCallback(async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'role') {
        await update.mutateAsync({
          id: pending.member.id,
          role: pending.member.role === 'lead' ? 'seller' : 'lead',
        });
      } else {
        await remove.mutateAsync(pending.member.id);
      }
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'last_lead'
          ? t('members.lastLead')
          : apiErrorText(e),
      );
    }
    setPending(null);
  }, [pending, update, remove, t]);

  if (!members?.length) return null;
  const other = (m: Member) => (m.role === 'lead' ? 'seller' : 'lead');

  return (
    <View style={styles.group}>
      {pending ? (
        <View style={styles.confirm}>
          <ScaledText variant="label">
            {pending.kind === 'role'
              ? fill(t('members.confirmRole'), {
                  name: pending.member.display_name,
                  role: roleLabel(other(pending.member)),
                })
              : fill(t('members.confirmRemove'), {
                  name: pending.member.display_name,
                })}
          </ScaledText>
          <View style={styles.buttons}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('members.cancel')}
              pressedScale={0.96}
              onPress={cancel}
              style={[styles.button, styles.secondary]}
            >
              <ScaledText variant="label">{t('members.cancel')}</ScaledText>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('members.yes')}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              pressedScale={0.96}
              onPress={confirm}
              style={[styles.button, styles.primary]}
            >
              <ScaledText variant="label" style={styles.primaryText}>
                {t('members.yes')}
              </ScaledText>
            </PressableScale>
          </View>
        </View>
      ) : null}
      {error ? (
        <ScaledText
          variant="body"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </ScaledText>
      ) : null}
      {members.map((member) => (
        <View key={member.id} style={styles.member}>
          <ScaledText variant="label" style={styles.name}>
            {member.display_name} · {roleLabel(member.role)}
          </ScaledText>
          <View style={styles.buttons}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={fill(t('members.changeRoleLabel'), {
                name: member.display_name,
              })}
              pressedScale={0.96}
              onPress={() => ask({ kind: 'role', member })}
              style={[styles.button, styles.secondary]}
            >
              <ScaledText variant="label">{t('members.changeRole')}</ScaledText>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={fill(t('members.removeLabel'), {
                name: member.display_name,
              })}
              pressedScale={0.96}
              onPress={() => ask({ kind: 'remove', member })}
              style={[styles.button, styles.secondary]}
            >
              <ScaledText variant="label" style={styles.danger}>
                {t('members.remove')}
              </ScaledText>
            </PressableScale>
          </View>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  group: { gap: space[2] },
  member: {
    gap: space[2],
    padding: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  name: { color: colors.ink },
  confirm: {
    gap: space[3],
    padding: space[3],
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  buttons: { flexDirection: 'row', gap: space[2] },
  button: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[3],
    borderRadius: radius.lg,
  },
  secondary: { backgroundColor: colors.surface },
  primary: { backgroundColor: colors.ink },
  primaryText: { color: colors.onInk },
  danger: { color: colors.danger },
  error: { color: colors.danger },
});
