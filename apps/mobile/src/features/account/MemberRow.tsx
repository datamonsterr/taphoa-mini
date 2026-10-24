import { QrCode, Users } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { CircleButton, Icon, ScaledText, Text } from '@/components/ui';
import type { Member } from '@/lib/api';
import { colors, fontFamily, radius, space } from '@/theme';

import { initialOf } from './utils';

const AVATAR_COLORS = [colors.ink, colors.success, colors.warning] as const;

type AvatarProps = { label: string; initial: string; background: string };

const Avatar = memo(function Avatar({
  label,
  initial,
  background,
  first,
}: AvatarProps & { first: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[
        styles.avatar,
        { backgroundColor: background },
        !first && styles.overlap,
      ]}
    >
      <Text style={styles.initial}>{initial}</Text>
    </View>
  );
});

export type MemberRowProps = {
  members: Member[] | undefined;
  failed: boolean;
  roleLabel: (role: Member['role']) => string;
  countLabel: string;
  errorLabel: string;
  inviteLabel: string | null;
  onInvite: () => void;
};

/**
 * Board: people icon, overlapping initials, invite-by-QR ink circle. The initials are one
 * accessible element labelled with the member count, so TalkBack and Maestro read "3 thành viên".
 */
export const MemberRow = memo(function MemberRow({
  members,
  failed,
  roleLabel,
  countLabel,
  errorLabel,
  inviteLabel,
  onInvite,
}: MemberRowProps) {
  return (
    <View style={styles.row}>
      <Icon icon={Users} color={colors.inkMuted} />
      {failed ? (
        <ScaledText variant="caption" style={styles.error}>
          {errorLabel}
        </ScaledText>
      ) : (
        <View accessible accessibilityLabel={countLabel} style={styles.avatars}>
          {members?.map((member, index) => (
            <Avatar
              key={member.id}
              first={index === 0}
              label={`${member.display_name}, ${roleLabel(member.role)}`}
              initial={initialOf(member.display_name)}
              background={AVATAR_COLORS[index % AVATAR_COLORS.length]!}
            />
          ))}
        </View>
      )}
      {inviteLabel ? (
        <CircleButton
          icon={QrCode}
          variant="ink"
          accessibilityLabel={inviteLabel}
          onPress={onInvite}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[3],
    paddingRight: space[3],
    paddingLeft: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  avatars: { flex: 1, flexDirection: 'row' },
  avatar: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    boxShadow: `0 0 0 3px ${colors.surfaceSoft}`,
  },
  overlap: { marginLeft: -10 },
  initial: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 17,
    color: colors.onInk,
  },
  error: { flex: 1, color: colors.danger },
});
