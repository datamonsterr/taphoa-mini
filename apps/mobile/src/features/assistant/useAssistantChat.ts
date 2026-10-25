import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
  type AssistantAction,
  type AssistantStreamEvent,
} from '@taphoa/api-client';

import { capture } from '@/lib/analytics';
import { getApiClient } from '@/lib/api/client';
import { newUuid } from '@/lib/uuid';
import type { Language } from '@/stores/settings';

import { assistantKeys, useAssistantThread } from './api';
import {
  chatReducer,
  initialChatState,
  type AssistantAttachment,
  type ChatError,
  type ChatMessage,
  type FeedbackRating,
} from './chatReducer';

export type SendOptions = {
  input: 'text' | 'voice';
  attachments?: AssistantAttachment[];
};

export type AssistantChat = {
  messages: ChatMessage[];
  streaming: boolean;
  send: (content: string, options: SendOptions) => void;
  /** Sends the last user message again as a new turn. */
  retry: () => void;
  updateAction: (action: AssistantAction) => void;
  setFeedback: (messageId: string, rating: FeedbackRating | null) => void;
  /** True while the stored thread is loading for the first time. */
  loading: boolean;
};

const isAbort = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

/**
 * One thread's chat: hydrates the stored messages once, streams each turn with the shared API
 * client and never re-sends a stream by itself.
 */
export function useAssistantChat({
  threadId,
  language,
}: {
  threadId: string | undefined;
  language: Language;
}): AssistantChat {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const thread = useAssistantThread(threadId);
  const stateRef = useRef(state);
  const hydratedFor = useRef<string | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A thread change (or unmount) drops the old stream and chat.
  useEffect(() => {
    hydratedFor.current = undefined;
    active.current = false;
    dispatch({ type: 'reset' });
    return () => {
      controller.current?.abort();
      controller.current = null;
      active.current = false;
    };
  }, [threadId]);

  // Hydrate once per thread; later refetches (and a turn already started) never overwrite it.
  useEffect(() => {
    if (!threadId || !thread.data || hydratedFor.current === threadId) return;
    hydratedFor.current = threadId;
    dispatch({ type: 'hydrate', detail: thread.data });
  }, [threadId, thread.data]);

  const start = useCallback(
    async (
      content: string,
      input: 'text' | 'voice',
      attachments: AssistantAttachment[],
      retry: boolean,
    ) => {
      if (!threadId || active.current) return;
      active.current = true;
      hydratedFor.current = threadId;
      const turns = stateRef.current.messages.filter(
        (m) => m.kind === 'user',
      ).length;
      capture('assistant_message_sent', {
        input,
        thread_turn: retry ? turns : turns + 1,
      });
      dispatch({
        type: 'send',
        userId: newUuid(),
        assistantId: newUuid(),
        content,
        attachments,
        retry,
      });
      const abort = new AbortController();
      controller.current = abort;
      const startedAt = Date.now();
      let tools = 0;
      let errorCode: Parameters<
        typeof capture<'assistant_reply_received'>
      >[1]['error_code'] = null;
      const fail = (error: ChatError) => {
        errorCode = error.code === 'interrupted' ? 'timeout' : 'internal';
        dispatch({ type: 'failed', error });
      };
      try {
        const result = await getApiClient().sendAssistantMessage(
          threadId,
          {
            content,
            language,
            ...(attachments.length ? { attachments } : {}),
          },
          { signal: abort.signal },
        );
        if (!result.events) {
          const body = result.error as { error?: unknown } | undefined;
          fail({
            code: 'network',
            ...(typeof body?.error === 'string' ? { message: body.error } : {}),
          });
        } else {
          for await (const event of result.events) {
            if (abort.signal.aborted) return;
            if (event.event === 'tool.started') tools++;
            if (event.event === 'error') errorCode = event.data.code;
            dispatch({ type: 'event', event: event as AssistantStreamEvent });
          }
        }
      } catch (error) {
        if (abort.signal.aborted || isAbort(error)) return;
        fail({
          code:
            error instanceof AssistantStreamInterruptedError ||
            error instanceof AssistantStreamProtocolError
              ? 'interrupted'
              : 'network',
        });
      }
      if (abort.signal.aborted) return;
      active.current = false;
      capture('assistant_reply_received', {
        latency_ms: Date.now() - startedAt,
        tools_count: tools,
        error_code: errorCode,
      });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.threads() });
    },
    [threadId, language, queryClient],
  );

  const send = useCallback(
    (content: string, options: SendOptions) => {
      void start(content, options.input, options.attachments ?? [], false);
    },
    [start],
  );

  const retry = useCallback(() => {
    const { messages } = stateRef.current;
    const last = messages.findLast((m) => m.kind === 'user');
    if (last?.kind !== 'user') return;
    void start(last.content, 'text', last.attachments, true);
  }, [start]);

  const updateAction = useCallback(
    (action: AssistantAction) => dispatch({ type: 'actionUpdated', action }),
    [],
  );
  const setFeedback = useCallback(
    (messageId: string, rating: FeedbackRating | null) =>
      dispatch({ type: 'feedback', messageId, rating }),
    [],
  );

  return {
    messages: state.messages,
    streaming: state.messages.some(
      (m) => m.kind === 'assistant' && m.status === 'streaming',
    ),
    send,
    retry,
    updateAction,
    setFeedback,
    loading: Boolean(threadId) && thread.isPending,
  };
}
