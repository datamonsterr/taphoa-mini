import { Plus, Trash2 } from 'lucide-react-native';
import { memo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/ScaledText';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, radius, size, space, typography } from '@/theme';

import { useAssistantThreads, useDeleteAssistantThread } from '../api';
import { dict } from '../strings';

export type ThreadListProps = {
  activeId: string | undefined;
  onOpen: (threadId: string) => void;
  onNew: () => void;
  onDeleted: (threadId: string) => void;
};

/** The member's threads: open one, delete one (with confirmation) or start a new chat. */
export const ThreadList = memo(function ThreadList({
  activeId,
  onOpen,
  onNew,
  onDeleted,
}: ThreadListProps) {
  const t = useT(dict);
  const language = useSettingsStore((s) => s.language);
  const threads = useAssistantThreads();
  const remove = useDeleteAssistantThread();
  const [confirming, setConfirming] = useState<string | null>(null);
  const items = threads.data ?? [];
  const date = new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  });

  return (
    <View testID="assistant-thread-list" style={styles.panel}>
      <PressableScale
        testID="thread-list-new"
        accessibilityRole="button"
        accessibilityLabel={t('newChat')}
        onPress={onNew}
        style={styles.newChat}
      >
        <Icon icon={Plus} color={colors.onAccent} />
        <Text style={styles.newChatText}>{t('newChat')}</Text>
      </PressableScale>
      {threads.isPending ? (
        <ActivityIndicator accessibilityLabel={t('loading')} />
      ) : null}
      {threads.isSuccess && items.length === 0 ? (
        <Text style={styles.empty}>{t('threadsEmpty')}</Text>
      ) : null}
      {items.map((thread) => (
        <View key={thread.id} style={styles.item}>
          {confirming === thread.id ? (
            <View style={styles.confirm}>
              <Text style={styles.title}>{t('deleteConfirm')}</Text>
              <View style={styles.confirmButtons}>
                <PressableScale
                  testID="thread-delete-confirm"
                  accessibilityRole="button"
                  accessibilityLabel={t('delete')}
                  disabled={remove.isPending}
                  onPress={() =>
                    remove.mutate(thread.id, {
                      onSuccess: () => {
                        setConfirming(null);
                        onDeleted(thread.id);
                      },
                    })
                  }
                  style={[styles.button, styles.danger]}
                >
                  <Text style={styles.dangerText}>{t('delete')}</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('cancel')}
                  onPress={() => setConfirming(null)}
                  style={[styles.button, styles.soft]}
                >
                  <Text style={styles.title}>{t('cancel')}</Text>
                </PressableScale>
              </View>
            </View>
          ) : (
            <>
              <PressableScale
                accessibilityRole="button"
                accessibilityState={{ selected: thread.id === activeId }}
                accessibilityLabel={thread.title ?? t('threadDefault')}
                pressedScale={0.98}
                onPress={() => onOpen(thread.id)}
                style={[styles.open, thread.id === activeId && styles.active]}
              >
                <Text numberOfLines={1} style={styles.title}>
                  {thread.title ?? t('threadDefault')}
                </Text>
                <Text style={styles.date}>
                  {date.format(new Date(thread.updated_at))}
                </Text>
              </PressableScale>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('deleteThread')}
                onPress={() => setConfirming(thread.id)}
                style={styles.trash}
              >
                <Icon icon={Trash2} color={colors.inkMuted} />
              </PressableScale>
            </>
          )}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { gap: space[3] },
  newChat: {
    minHeight: size.tapMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  newChatText: { ...typography.label, color: colors.onAccent },
  empty: { ...typography.body, color: colors.inkMuted },
  item: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  open: {
    flex: 1,
    minHeight: size.tapMin,
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  active: { backgroundColor: colors.accentSoft },
  title: { ...typography.label, color: colors.ink },
  date: { ...typography.caption, color: colors.inkMuted },
  trash: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirm: { flex: 1, gap: space[2] },
  confirmButtons: { flexDirection: 'row', gap: space[2] },
  button: {
    flex: 1,
    minHeight: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  danger: { backgroundColor: colors.danger },
  dangerText: { ...typography.label, color: colors.onInk },
  soft: { backgroundColor: colors.surfaceSoft },
});
