import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/ScaledText';
import { useT } from '@/lib/i18n';
import { colors, radius, space, typography } from '@/theme';

import type { UserChatMessage } from '../chatReducer';
import { dict } from '../strings';

export const UserBubble = memo(function UserBubble({
  message,
}: {
  message: UserChatMessage;
}) {
  const t = useT(dict);
  return (
    <View style={styles.row} testID="user-message">
      <View style={styles.bubble}>
        <Text style={styles.text}>{message.content}</Text>
      </View>
      {message.status === 'failed' ? (
        <Text style={styles.failed}>{t('userNotSent')}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { alignItems: 'flex-end', gap: space[1] },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.md,
    borderBottomRightRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  text: { ...typography.body, color: colors.onAccent },
  failed: { ...typography.caption, color: colors.danger },
});
