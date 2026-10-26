import { router, useLocalSearchParams } from 'expo-router';
import { List, Plus, X } from 'lucide-react-native';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton } from '@/components/ui/CircleButton';
import { Text } from '@/components/ui/ScaledText';
import { capture } from '@/lib/analytics';
import { fill, useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings';
import { colors, radius, shadows, space, typography } from '@/theme';

import {
  useAssistantThreads,
  useCreateAssistantThread,
  type CreateAssistantThreadInput,
} from './api';
import type { AssistantAttachment } from './chatReducer';
import { AssistantMessageView } from './chat/AssistantMessageView';
import type { ReceiptCardLine } from './chat/cards/ReceiptLinesCard';
import { Composer } from './chat/Composer';
import { ErrorNotice } from './chat/ErrorNotice';
import { ReceiptStatusRow } from './chat/ReceiptStatusRow';
import { ThreadList } from './chat/ThreadList';
import { UserBubble } from './chat/UserBubble';
import type { AssistantRouteParams } from './route';
import { dict } from './strings';
import { useAssistantChat } from './useAssistantChat';
import { useReceiptChat } from './useReceiptChat';

const TOP_GAP = 8;

type Turn = {
  content: string;
  input: 'text' | 'voice';
  attachments?: AssistantAttachment[];
};
type PendingTurn = Turn & { threadId: string };

/**
 * The assistant sheet: header, message list (or the thread list) and the composer. A new chat has
 * no thread until its first send; the thread is created then, and the turn is sent once the chat
 * hook is bound to it.
 */
export function AssistantScreen() {
  const t = useT(dict);
  const language = useSettingsStore((s) => s.language);
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams() as Partial<AssistantRouteParams>;
  const autoStart = Boolean(params.receiptId || params.prompt);

  const [threadId, setThreadId] = useState(params.threadId);
  // `auto`: still looking for the newest thread to reopen.
  const [phase, setPhase] = useState<'auto' | 'chosen'>(
    params.threadId || autoStart ? 'chosen' : 'auto',
  );
  const [fromEntry, setFromEntry] = useState(true);
  const [showList, setShowList] = useState(false);
  const pending = useRef<PendingTurn | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [prefill, setPrefill] = useState<{ id: number; text: string }>();
  const lastTurn = useRef<Turn | null>(null);

  const threads = useAssistantThreads();
  const createThread = useCreateAssistantThread();
  const chat = useAssistantChat({ threadId, language });

  // Leave `auto` with the newest thread, or with an empty new chat when the list failed.
  if (phase === 'auto' && (threads.isSuccess || threads.isError)) {
    setPhase('chosen');
    if (threads.isSuccess) setThreadId(threads.data[0]?.id);
  }

  /** True while a thread is being created or a created thread's first turn is not yet sent. */
  const starting = useRef(false);
  /** Bumped when the user leaves the chat, so a thread created for it is not adopted late. */
  const epoch = useRef(0);

  /** Returns whether the turn was accepted (the composer clears its text only then). */
  const startTurn = useCallback(
    (turn: Turn): boolean => {
      if (starting.current) return false;
      // The user chose: a late threads list must not replace this chat.
      setPhase('chosen');
      if (threadId) {
        const accepted = chat.send(turn.content, {
          input: turn.input,
          ...(turn.attachments ? { attachments: turn.attachments } : {}),
        });
        if (accepted) {
          lastTurn.current = turn;
          setStartFailed(false);
        }
        return accepted;
      }
      lastTurn.current = turn;
      setStartFailed(false);
      starting.current = true;
      const context: CreateAssistantThreadInput['context'] = fromEntry
        ? {
            screen: params.screen ?? 'chat',
            ...(params.nextStepId ? { next_step_id: params.nextStepId } : {}),
            ...(params.receiptId ? { receipt_id: params.receiptId } : {}),
          }
        : { screen: 'chat' };
      const mine = epoch.current;
      createThread.mutateAsync({ context }).then(
        (thread) => {
          if (mine !== epoch.current) {
            starting.current = false;
            return;
          }
          pending.current = { ...turn, threadId: thread.id };
          setThreadId(thread.id);
        },
        () => {
          starting.current = false;
          setStartFailed(true);
        },
      );
      return true;
    },
    [threadId, chat, fromEntry, params, createThread],
  );

  // Send the turn that created the thread once the chat is bound to the new thread.
  const { send, loading: loadingChat } = chat;
  useEffect(() => {
    const turn = pending.current;
    // The chat refuses a send until the new thread's (empty) history has been read.
    if (!turn || turn.threadId !== threadId || loadingChat) return;
    pending.current = null;
    starting.current = false;
    send(turn.content, {
      input: turn.input,
      ...(turn.attachments ? { attachments: turn.attachments } : {}),
    });
  }, [threadId, send, loadingChat]);

  // Once per open: analytics, then the entry's own first message. The event reads the latest
  // props; the effect itself never runs twice.
  const opened = useRef(false);
  const onOpen = useEffectEvent(() => {
    capture('assistant_opened', { entry: params.entry ?? 'button' });
    if (params.receiptId)
      startTurn({
        content: t('receiptFirstMessage'),
        input: 'text',
        attachments: [{ receipt_id: params.receiptId }],
      });
    else if (params.prompt)
      startTurn({ content: params.prompt, input: 'text' });
  });
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    onOpen();
  }, []);

  const openThread = (id: string | undefined) => {
    epoch.current++;
    starting.current = false;
    pending.current = null;
    setThreadId(id);
    setPhase('chosen');
    setFromEntry(false);
    setShowList(false);
    setStartFailed(false);
  };

  const receipt = useReceiptChat({
    entryReceiptId: fromEntry ? params.receiptId : undefined,
    threadId,
    threadFailed: startFailed,
    chat,
    restartThread: () => {
      if (lastTurn.current) startTurn(lastTurn.current);
    },
    firstMessage: t('receiptFirstMessage'),
  });

  const scroller = useRef<ScrollViewInstance>(null);
  const title =
    threads.data?.find((thread) => thread.id === threadId)?.title ?? t('title');
  const loading = phase === 'auto' || chat.loading;
  const messageProps = {
    onRetry: chat.retry,
    onLinePress: (line: ReceiptCardLine) =>
      setPrefill((previous) => ({
        id: (previous?.id ?? 0) + 1,
        text: fill(t('linePrefill'), { name: line.name }),
      })),
    onActionUpdate: chat.updateAction,
    onFeedback: chat.setFeedback,
  };

  return (
    <View testID="assistant-screen" style={styles.root}>
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={() => router.back()}
        style={styles.scrim}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        pointerEvents="box-none"
        style={styles.avoid}
      >
        <View
          style={[
            styles.panel,
            {
              marginTop: insets.top + TOP_GAP,
              paddingBottom: space[3] + insets.bottom,
            },
          ]}
        >
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={styles.title}
            >
              {title}
            </Text>
            <CircleButton
              testID="assistant-threads"
              icon={List}
              accessibilityLabel={t('openThreads')}
              onPress={() => setShowList((open) => !open)}
            />
            <CircleButton
              testID="assistant-new-chat"
              icon={Plus}
              accessibilityLabel={t('newChat')}
              onPress={() => openThread(undefined)}
            />
            <CircleButton
              testID="assistant-close"
              icon={X}
              accessibilityLabel={t('close')}
              onPress={() => router.back()}
            />
          </View>
          {!showList && receipt.receiptId ? (
            <ReceiptStatusRow
              receiptId={receipt.receiptId}
              state={receipt.state}
              onRetry={receipt.retry}
            />
          ) : null}
          <ScrollView
            ref={scroller}
            testID="assistant-messages"
            style={styles.messages}
            contentContainerStyle={styles.messagesContent}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() =>
              scroller.current?.scrollToEnd({ animated: false })
            }
          >
            {showList ? (
              <ThreadList
                activeId={threadId}
                onOpen={openThread}
                onNew={() => openThread(undefined)}
                onDeleted={(id) => {
                  if (id === threadId) openThread(undefined);
                }}
              />
            ) : loading ? (
              <ActivityIndicator accessibilityLabel={t('loading')} />
            ) : (
              <>
                {chat.messages.length === 0 ? (
                  <Text testID="assistant-empty" style={styles.empty}>
                    {t('emptyChat')}
                  </Text>
                ) : null}
                {chat.messages.map((message) =>
                  message.kind === 'user' ? (
                    <UserBubble key={message.id} message={message} />
                  ) : (
                    <AssistantMessageView
                      key={message.id}
                      message={message}
                      {...messageProps}
                    />
                  ),
                )}
                {startFailed ? (
                  <ErrorNotice
                    error={{ code: 'network' }}
                    onRetry={() => {
                      if (lastTurn.current) startTurn(lastTurn.current);
                    }}
                  />
                ) : null}
              </>
            )}
          </ScrollView>
          {showList ? null : (
            <Composer
              streaming={chat.streaming || createThread.isPending || loading}
              onSend={(content, input) => startTurn({ content, input })}
              prefill={prefill}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  avoid: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    flex: 1,
    gap: space[3],
    paddingHorizontal: space[4],
    paddingTop: space[4],
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
    ...shadows.sheet,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { ...typography.heading, flex: 1, color: colors.ink },
  messages: { flex: 1 },
  messagesContent: { flexGrow: 1, gap: space[4], paddingVertical: space[2] },
  empty: { ...typography.body, color: colors.inkMuted },
});
