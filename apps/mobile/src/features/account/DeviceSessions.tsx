import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Plus, Smartphone } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  CircleButton,
  Icon,
  PressableScale,
  ScaledText,
  Text,
} from '@/components/ui';
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

/**
 * Where the list is shown. `account`: the account tab, with the current person and "add".
 * `signIn`: the sign-in screen of a phone that still has people signed in; nobody is current.
 */
export type DeviceSessionsVariant = 'account' | 'signIn';

/**
 * Row ids are `<prefix>-<index>`, the list `<prefix>s` and its error `<prefix>s-error`:
 * `account-session-0`, `account-sessions`, `auth-device-session-0`, `auth-device-sessions`.
 */
const VARIANTS = {
  account: {
    prefix: 'account-session',
    title: 'sessions.title',
    rowLabel: 'sessions.switchTo',
  },
  signIn: {
    prefix: 'auth-device-session',
    title: 'sessions.pickTitle',
    rowLabel: 'sessions.pickRow',
  },
} as const;

type RowProps = {
  session: DeviceSession;
  index: number;
  variant: DeviceSessionsVariant;
  current: boolean;
  busy: boolean;
  onSwitch: (session: DeviceSession) => void;
};

/** One person on this phone. Others are read with their own session token, cached per session. */
const SessionRow = memo(function SessionRow({
  session,
  index,
  variant,
  current,
  busy,
  onSwitch,
}: RowProps) {
  const t = useT(strings);
  const { prefix, rowLabel } = VARIANTS[variant];
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
      testID={`${prefix}-${index}`}
      accessibilityRole="button"
      accessibilityLabel={
        current
          ? `${name}, ${t('sessions.current')}`
          : fill(t(rowLabel), { name })
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
  variant?: DeviceSessionsVariant;
  sessions: DeviceSession[];
  currentId: string | null;
  busy: boolean;
  error: string | null;
  onSwitch: (session: DeviceSession) => void;
  /** Adds the "add a person" row; the sign-in screen has its own form for that. */
  onAdd?: () => void;
};

/** Everyone signed in on this phone: tap to switch, or add another person without signing out. */
export const DeviceSessions = memo(function DeviceSessions({
  variant = 'account',
  sessions,
  currentId,
  busy,
  error,
  onSwitch,
  onAdd,
}: DeviceSessionsProps) {
  const t = useT(strings);
  const { prefix, title } = VARIANTS[variant];
  return (
    <View testID={`${prefix}s`} style={styles.group}>
      {onAdd ? (
        // Board 12: one row with the people count and a "+" that adds a person.
        <View style={styles.head}>
          <Icon icon={Smartphone} color={colors.inkMuted} />
          <ScaledText
            variant="label"
            accessibilityRole="header"
            style={styles.grow}
          >
            {t(title)}
          </ScaledText>
          <View style={styles.count}>
            <ScaledText variant="label" style={styles.countText}>
              {sessions.length}
            </ScaledText>
          </View>
          <CircleButton
            testID="account-add-person"
            icon={Plus}
            variant="surface"
            accessibilityLabel={t('sessions.add')}
            onPress={onAdd}
          />
        </View>
      ) : (
        <ScaledText variant="label" accessibilityRole="header">
          {t(title)}
        </ScaledText>
      )}
      {sessions.map((session, index) => (
        <SessionRow
          key={session.id}
          session={session}
          index={index}
          variant={variant}
          current={session.id === currentId}
          busy={busy}
          onSwitch={onSwitch}
        />
      ))}
      {error ? (
        <ScaledText
          testID={`${prefix}s-error`}
          accessibilityRole="alert"
          variant="caption"
          style={styles.error}
        >
          {error}
        </ScaledText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  group: { gap: space[2] },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 72,
    paddingLeft: space[4],
    paddingRight: space[2],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  count: {
    minWidth: 32,
    height: 32,
    paddingHorizontal: space[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  countText: { fontVariant: ['tabular-nums'], color: colors.ink },
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
