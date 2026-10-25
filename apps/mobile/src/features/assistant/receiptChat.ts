import type { AssistantAction } from '@taphoa/api-client';

import type { ChatMessage } from './chatReducer';

/**
 * The life of one receipt thread, seen from the chat. The camera creates the receipt before the
 * chat opens, so the machine starts at `creating_thread`.
 */
export type ReceiptPhase =
  | 'creating_thread'
  | 'sending'
  | 'reviewing'
  | 'awaiting_confirm'
  | 'confirming'
  | 'confirmed'
  | 'rejected'
  | 'expired'
  | 'failed';

/** Which step failed: creating the thread, streaming a reply, or the proposed action. */
export type ReceiptFailure = 'thread' | 'stream' | 'action';

export type ReceiptChatState = {
  phase: ReceiptPhase;
  /** Set only while `phase` is `failed`. */
  failure: ReceiptFailure | null;
};

export type ReceiptChatEvent =
  | { type: 'threadCreated' }
  | { type: 'threadFailed' }
  | { type: 'linesArrived' }
  | { type: 'actionProposed' }
  | { type: 'confirmStarted' }
  | { type: 'confirmed' }
  | { type: 'rejected' }
  | { type: 'expired' }
  | { type: 'actionFailed' }
  | { type: 'streamFailed' }
  | { type: 'retry' }
  /** A stored thread was opened: take the state read from its messages (once). */
  | { type: 'reopened'; state: ReceiptChatState };

const at = (phase: ReceiptPhase): ReceiptChatState => ({
  phase,
  failure: null,
});
const failed = (failure: ReceiptFailure): ReceiptChatState => ({
  phase: 'failed',
  failure,
});

export const initialReceiptChatState: ReceiptChatState = at('creating_thread');

/** Events that do not fit the current state are ignored (the same state object comes back). */
export function receiptChatReducer(
  state: ReceiptChatState,
  event: ReceiptChatEvent,
): ReceiptChatState {
  const { phase } = state;
  switch (event.type) {
    case 'reopened':
      return phase === 'creating_thread' ? event.state : state;
    case 'threadCreated':
      return phase === 'creating_thread' ? at('sending') : state;
    case 'threadFailed':
      return phase === 'creating_thread' ? failed('thread') : state;
    case 'linesArrived':
      return phase === 'sending' ? at('reviewing') : state;
    case 'actionProposed':
      return phase === 'sending' ||
        phase === 'reviewing' ||
        phase === 'rejected' ||
        phase === 'expired'
        ? at('awaiting_confirm')
        : state;
    case 'confirmStarted':
      return phase === 'awaiting_confirm' || state.failure === 'action'
        ? at('confirming')
        : state;
    case 'confirmed':
      return phase === 'awaiting_confirm' ||
        phase === 'confirming' ||
        state.failure === 'action'
        ? at('confirmed')
        : state;
    case 'rejected':
      return phase === 'awaiting_confirm' || phase === 'confirming'
        ? at('rejected')
        : state;
    case 'expired':
      return phase === 'awaiting_confirm' || phase === 'confirming'
        ? at('expired')
        : state;
    case 'actionFailed':
      return phase === 'awaiting_confirm' || phase === 'confirming'
        ? failed('action')
        : state;
    case 'streamFailed':
      return phase === 'sending' || phase === 'reviewing'
        ? failed('stream')
        : state;
    case 'retry':
      if (state.failure === 'thread') return at('creating_thread');
      return state.failure === null ? state : at('sending');
  }
}

const actionPhase: Record<AssistantAction['status'], ReceiptChatState> = {
  proposed: at('awaiting_confirm'),
  executing: at('confirming'),
  done: at('confirmed'),
  rejected: at('rejected'),
  expired: at('expired'),
  failed: failed('action'),
};

/**
 * Reads the phase of a receipt thread from its chat messages, so a reopened thread lands in the
 * right place. The latest `receipt_confirm` action decides; without one, an errored or empty
 * reply fails the stream, a `receipt_lines` card for this receipt means reviewing, and anything
 * still streaming (or not yet answered) means sending. `staleActionIds` are proposals the server
 * has already refused as expired. While `sending` (a retry was sent), only the replies after the
 * last user message count: the failed action of the earlier turn must not hide the new one.
 */
export function deriveReceiptPhase(
  messages: ChatMessage[],
  receiptId: string,
  {
    staleActionIds,
    retiredActionIds,
    sending = false,
  }: {
    staleActionIds?: ReadonlySet<string>;
    /** Proposals a retry replaced: they no longer decide the phase. */
    retiredActionIds?: ReadonlySet<string>;
    sending?: boolean;
  } = {},
): ReceiptChatState {
  if (sending)
    messages = messages.slice(
      messages.findLastIndex((m) => m.kind === 'user') + 1,
    );
  let latest: AssistantAction | undefined;
  let lines = false;
  for (const message of messages) {
    if (message.kind !== 'assistant') continue;
    for (const card of message.cards)
      if (card.type === 'receipt_lines' && card.receipt_id === receiptId)
        lines = true;
    for (const action of message.actions)
      if (
        action.kind === 'receipt_confirm' &&
        !retiredActionIds?.has(action.id) &&
        (action.payload.receipt_id === undefined ||
          action.payload.receipt_id === receiptId)
      )
        latest = action;
  }
  if (latest)
    return staleActionIds?.has(latest.id) && latest.status === 'proposed'
      ? at('expired')
      : actionPhase[latest.status];

  const last = messages.at(-1);
  if (last?.kind === 'assistant' && last.status === 'error')
    return failed('stream');
  if (lines) return at('reviewing');
  if (last?.kind === 'assistant' && last.status === 'done')
    return failed('stream');
  return at('sending');
}

/** The event that moves the machine to a state read from the messages; null when none fits. */
export function receiptEventFor(
  derived: ReceiptChatState,
): ReceiptChatEvent | null {
  switch (derived.phase) {
    case 'reviewing':
      return { type: 'linesArrived' };
    case 'awaiting_confirm':
      return { type: 'actionProposed' };
    case 'confirming':
      return { type: 'confirmStarted' };
    case 'confirmed':
      return { type: 'confirmed' };
    case 'rejected':
      return { type: 'rejected' };
    case 'expired':
      return { type: 'expired' };
    case 'failed':
      if (derived.failure === 'stream') return { type: 'streamFailed' };
      return derived.failure === 'action' ? { type: 'actionFailed' } : null;
    default:
      return null;
  }
}

/** The newest `receipt_confirm` action of this receipt in the chat, if any. */
export function latestReceiptAction(
  messages: ChatMessage[],
  receiptId: string,
): AssistantAction | undefined {
  let latest: AssistantAction | undefined;
  for (const message of messages)
    if (message.kind === 'assistant')
      for (const action of message.actions)
        if (
          action.kind === 'receipt_confirm' &&
          (action.payload.receipt_id === undefined ||
            action.payload.receipt_id === receiptId)
        )
          latest = action;
  return latest;
}
