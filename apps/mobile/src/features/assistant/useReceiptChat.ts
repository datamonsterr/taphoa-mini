import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/errors';
import { keys } from '@/lib/api/keys';

import { useAssistantThread } from './api';
import type { AssistantChat } from './useAssistantChat';
import {
  deriveReceiptPhase,
  initialReceiptChatState,
  receiptChatReducer,
  receiptEventFor,
  type ReceiptChatEvent,
  type ReceiptChatState,
} from './receiptChat';

export type ReceiptChat = {
  /** The receipt this thread is about; undefined for any other chat. */
  receiptId: string | undefined;
  state: ReceiptChatState;
  /** Retries whichever step failed (thread, reply or proposed action). */
  retry: () => void;
};

export type UseReceiptChatOptions = {
  /** `receiptId` of the entry that is opening a new thread; undefined once the user moved on. */
  entryReceiptId: string | undefined;
  threadId: string | undefined;
  /** Creating the thread failed. */
  threadFailed: boolean;
  chat: Pick<AssistantChat, 'messages' | 'loading' | 'send' | 'retry'>;
  /** Creates the thread again and sends the entry turn. */
  restartThread: () => void;
  /** The fixed first message asking the assistant to check the receipt. */
  firstMessage: string;
};

const reduce = (
  state: ReceiptChatState,
  event: ReceiptChatEvent | 'reset',
): ReceiptChatState =>
  event === 'reset'
    ? initialReceiptChatState
    : receiptChatReducer(state, event);

/**
 * Drives the receipt-in-chat machine for one thread. It reads the chat messages (so a reopened
 * thread lands in the right phase), learns of expired proposals from the confirm mutation, and
 * refreshes the receipt, stock and product queries once the receipt is confirmed. The success
 * haptic comes from the action card that confirms.
 */
export function useReceiptChat({
  entryReceiptId,
  threadId,
  threadFailed,
  chat,
  restartThread,
  firstMessage,
}: UseReceiptChatOptions): ReceiptChat {
  const queryClient = useQueryClient();
  const thread = useAssistantThread(threadId);
  const receiptId =
    entryReceiptId ?? thread.data?.thread.context?.receipt_id ?? undefined;
  const [state, dispatch] = useReducer(reduce, initialReceiptChatState);
  const [staleActionIds, setStaleActionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const { messages, loading, send, retry: retryMessage } = chat;
  const stored = thread.data?.messages.length ?? 0;

  // A different receipt or thread starts the machine over; creating the first thread does not.
  const scope = useRef({ threadId, receiptId });
  useEffect(() => {
    const before = scope.current;
    scope.current = { threadId, receiptId };
    if (
      before.receiptId !== receiptId ||
      (before.threadId && before.threadId !== threadId)
    ) {
      dispatch('reset');
      setStaleActionIds(new Set());
    }
  }, [threadId, receiptId]);

  // The card shows the 409 itself and does not tell the chat: take it from the mutation cache.
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const id = event.mutation.state.variables;
        if (
          typeof id === 'string' &&
          isApiError(event.action.error) &&
          event.action.error.code === 'action_stale'
        )
          setStaleActionIds((ids) => new Set(ids).add(id));
      }),
    [queryClient],
  );

  useEffect(() => {
    if (!receiptId) return;
    const derived = () =>
      deriveReceiptPhase(messages, receiptId, { staleActionIds });
    if (state.phase === 'creating_thread') {
      if (threadFailed) dispatch({ type: 'threadFailed' });
      // A stored thread's messages reach `messages` one render after it loads: wait for them.
      else if (threadId && !loading && (messages.length > 0 || stored === 0))
        dispatch(
          messages.length
            ? { type: 'reopened', state: derived() }
            : { type: 'threadCreated' },
        );
      return;
    }
    const event = receiptEventFor(derived());
    if (event) dispatch(event);
  }, [
    receiptId,
    state.phase,
    threadId,
    threadFailed,
    loading,
    messages,
    stored,
    staleActionIds,
  ]);

  // Confirmed during this visit (not just opened that way): the receipt changed stock and costs.
  const previous = useRef(state.phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = state.phase;
    if (
      state.phase === 'confirmed' &&
      before !== 'confirmed' &&
      before !== 'creating_thread'
    ) {
      void queryClient.invalidateQueries({ queryKey: keys.receipts.all() });
      void queryClient.invalidateQueries({ queryKey: keys.stock.all() });
      void queryClient.invalidateQueries({ queryKey: keys.products.all() });
    }
  }, [state.phase, queryClient]);

  const retry = useCallback(() => {
    if (!receiptId) return;
    if (state.failure === 'thread') restartThread();
    else if (state.failure === 'stream') retryMessage();
    else if (state.failure === 'action')
      send(firstMessage, {
        input: 'text',
        attachments: [{ receipt_id: receiptId }],
      });
    dispatch({ type: 'retry' });
  }, [
    receiptId,
    state.failure,
    restartThread,
    retryMessage,
    send,
    firstMessage,
  ]);

  return { receiptId, state, retry };
}
