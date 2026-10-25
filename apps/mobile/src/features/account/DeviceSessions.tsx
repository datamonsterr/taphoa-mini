import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, UserPlus } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, ScaledText, Text } from '@/components/ui';
import {
  deviceMeKey,
  personName,
  type DeviceSession,
} from '@/features/auth/deviceSessions';
import { fetchSessionMe } from '@/features/auth/sessionApi';
import { useMe } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';

import { fill, strings } from './strings';
import { initialOf } from './utils';

type RowProps = {
  session: DeviceSession;
  index: number;
  current: boolean;
  busy: boolean;
  onSwitch: (session: DeviceSession) => void;
};

/** One person on this phone. Others are read with their own session token, cached per session. */
const SessionRow = memo(function SessionRow({
  session,
  index,
  current,
  busy,
  onSwitch,
}: RowProps) {
  const t = useT(strings);
  // The active person is already loaded by the app; everyone else costs one request each.
  const mine = useMe(current);
  const theirs = useQuery({
    queryKey: deviceMeKey(session.id),
    queryFn: () => fetchSessionMe(session),
    enabled: !current,
    staleTime: 60_000,
    retry: false,
  });
  const name =
    personName(session, current ? mine.data : theirs.data) ||
    t('sessions.unknown');
  return (
    <PressableScale
      testID={`account-session-${index}`}
      accessibilityRole="button"
      accessibilityLabel={
        current
          ? `${name}, ${t('sessions.current')}`
          : fill(t('sessions.switchTo'), { name })
      }
      accessibilityState={{ selected: current, disabled: current || busy }}
      disabled={current || busy}
      pressedScale={0.98}
      onPress={() => onSwitch(session)}
      style={[styles.row, current && styles.rowCurrent]}
    >
      <View style={styles.avatar}>
        <Text style={styles.initial}>{initialOf(name)}</Text>
      </View>
      <ScaledText variant="label" numberOfLines={1} style={styles.grow}>
        {name}
      </ScaledText>
      {current ? (
        <View style={styles.badge}>
          <Icon icon={Check} size={18} color={colors.success} />
          <ScaledText variant="caption" style={styles.badgeText}>
            {t('sessions.current')}
          </ScaledText>
        </View>
      ) : (
        <Icon icon={ChevronRight} color={colors.inkMuted} />
      )}
    </PressableScale>
  );
});

export type DeviceSessionsProps = {
  sessions: DeviceSession[];
  currentId: string | null;
  busy: boolean;
  error: string | null;
  onSwitch: (session: DeviceSession) => void;
  onAdd: () => void;
};

/** Everyone signed in on this phone: tap to switch, or add another person without signing out. */
export const DeviceSessions = memo(function DeviceSessions({
  sessions,
  currentId,
  busy,
  error,
  onSwitch,
  onAdd,
}: DeviceSessionsProps) {
  const t = useT(strings);
  return (
    <View testID="account-sessions" style={styles.group}>
      <ScaledText variant="label" accessibilityRole="header">
        {t('sessions.title')}
      </ScaledText>
      {sessions.map((session, index) => (
        <SessionRow
          key={session.id}
          session={session}
          index={index}
          current={session.id === currentId}
          busy={busy}
          onSwitch={onSwitch}
        />
      ))}
      {error ? (
        <ScaledText
          testID="account-sessions-error"
          accessibilityRole="alert"
          variant="caption"
          style={styles.error}
        >
          {error}
        </ScaledText>
      ) : null}
      <PressableScale
        testID="account-add-person"
        accessibilityRole="button"
        accessibilityLabel={t('sessions.add')}
        pressedScale={0.98}
        onPress={onAdd}
        style={styles.row}
      >
        <Icon icon={UserPlus} color={colors.inkMuted} />
        <ScaledText variant="label" style={styles.grow}>
          {t('sessions.add')}
        </ScaledText>
        <Icon icon={ChevronRight} color={colors.inkMuted} />
      </PressableScale>
    </View>
  );
});

const styles = StyleSheet.create({
  group: { gap: space[2] },
  grow: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 72,
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  rowCurrent: { borderWidth: 2, borderColor: colors.accent },
  avatar: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  initial: {
    fontFamily: fontFamily.extrabold,
    fontSize: 18,
    lineHeight: 22,
    color: colors.accent,
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  badgeText: { fontFamily: fontFamily.semibold, color: colors.success },
  error: { color: colors.danger },
});
