import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
  type AssistantAction,
  type AssistantStreamEvent,
} from '@taphoa/api-client';

import { capture } from '@/lib/analytics';
import { getApiClient } from '@/lib/api/client';
import { retryAfterMs } from '@/lib/api/errors';
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
  /** Starts a turn; false when it was refused (still loading, or a turn is running). */
  send: (content: string, options: SendOptions) => boolean;
  /** Sends the last user message again as a new turn. */
  retry: () => void;
  updateAction: (action: AssistantAction) => void;
  setFeedback: (messageId: string, rating: FeedbackRating | null) => void;
  /** True until the stored thread of this visit has been read into the chat. */
  loading: boolean;
};

const isAbort = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

/**
 * What a non-OK response to a message means for the seller. The request reached the server, so
 * "check your network" is wrong: 429 is the quota, 502/503/504 a busy server, other 5xx a fault.
 */
export function httpError(status: number, retryAfterMs?: number): ChatError {
  if (status === 429) return { code: 'quota' };
  if (status === 502 || status === 503 || status === 504)
    return { code: 'busy' };
  if (status >= 500) return { code: 'internal' };
  // The server's English text (`body.error`) is for logs only; the notice maps the status.
  return { code: 'http', status, ...(retryAfterMs ? { retryAfterMs } : {}) };
}

/**
 * One thread's chat: hydrates from the stored thread fetched after mount (and again while idle
 * when fresher data arrives), streams each turn with the shared API
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
  const hydratedAt = useRef(0);
  /** The thread whose stored messages are in the chat; drives `loading`. */
  const [hydratedId, setHydratedId] = useState<string | undefined>();
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);

  // `isFetchedAfterMount` also guards a switch back to a thread this hook hydrated before.
  const loading =
    Boolean(threadId) &&
    !(hydratedId === threadId && thread.isFetchedAfterMount) &&
    !thread.isError;
  const loadingRef = useRef(loading);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A thread change (or unmount) drops the old stream and chat.
  useEffect(() => {
    hydratedFor.current = undefined;
    hydratedAt.current = 0;
    active.current = false;
    dispatch({ type: 'reset' });
    return () => {
      controller.current?.abort();
      controller.current = null;
      active.current = false;
    };
  }, [threadId]);

  // Hydrate from data fetched after mount, never from what an earlier visit cached. Later fresh
  // data replaces the chat only while idle and when no failed turn is on screen (a failed turn
  // is the local truth until the user retries).
  useEffect(() => {
    if (!threadId || !thread.data || !thread.isFetchedAfterMount) return;
    if (active.current || thread.dataUpdatedAt <= hydratedAt.current) return;
    if (
      hydratedFor.current === threadId &&
      stateRef.current.messages.some(
        (m) =>
          (m.kind === 'assistant' && m.status === 'error') ||
          (m.kind === 'user' && m.status === 'failed'),
      )
    )
      return;
    hydratedFor.current = threadId;
    hydratedAt.current = thread.dataUpdatedAt;
    dispatch({ type: 'hydrate', detail: thread.data });
    setHydratedId(threadId);
  }, [threadId, thread.data, thread.dataUpdatedAt, thread.isFetchedAfterMount]);

  // A failed thread query must not block the chat forever: sending works without history.
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  /** Streams one turn into the chat; `active` is held by the caller until this ends. */
  const run = useCallback(
    async (
      abort: AbortController,
      id: string,
      content: string,
      attachments: AssistantAttachment[],
    ) => {
      const startedAt = Date.now();
      let tools = 0;
      let errorCode: Parameters<
        typeof capture<'assistant_reply_received'>
      >[1]['error_code'] = null;
      const fail = (error: ChatError) => {
        errorCode =
          error.code === 'interrupted'
            ? 'timeout'
            : error.code === 'quota'
              ? 'quota'
              : 'internal';
        dispatch({ type: 'failed', error });
      };
      try {
        const result = await getApiClient().sendAssistantMessage(
          id,
          {
            content,
            language,
            ...(attachments.length ? { attachments } : {}),
          },
          { signal: abort.signal },
        );
        if (!result.events) {
          fail(
            httpError(result.response.status, retryAfterMs(result.response)),
          );
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
      // The server now holds this turn: the cached thread must hold it too.
      void queryClient.invalidateQueries({
        queryKey: assistantKeys.thread(id),
      });
    },
    [language, queryClient],
  );

  const start = useCallback(
    (
      content: string,
      input: 'text' | 'voice',
      attachments: AssistantAttachment[],
      retry: boolean,
    ): boolean => {
      if (!threadId || active.current || loadingRef.current) return false;
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
      void run(abort, threadId, content, attachments);
      return true;
    },
    [threadId, run],
  );

  const send = useCallback(
    (content: string, options: SendOptions) => {
      return start(content, options.input, options.attachments ?? [], false);
    },
    [start],
  );

  const retry = useCallback(() => {
    const { messages } = stateRef.current;
    const last = messages.findLast((m) => m.kind === 'user');
    if (last?.kind !== 'user') return;
    start(last.content, 'text', last.attachments, true);
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
    loading,
  };
}
