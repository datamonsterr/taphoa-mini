import type {
  AssistantAction,
  AssistantCard,
  AssistantStreamEvent,
  components,
} from '@taphoa/api-client';

type Schemas = components['schemas'];
export type AssistantAttachment = Schemas['AssistantAttachment'];
export type AssistantStreamErrorCode = Schemas['AssistantStreamError']['code'];
/** `busy`: the server answered 502, 503 or 504 (a deploy or an overloaded edge). */
export type ChatErrorCode =
  AssistantStreamErrorCode | 'network' | 'interrupted' | 'busy' | 'http';
/**
 * `http`: the server refused the request (a 4xx other than 429); `status` and `retryAfterMs` pick
 * the Vietnamese sentence. `message` is the server's own text for a stream error and is shown only
 * for `quota` and the stream codes, never for `http`.
 */
export type ChatError = {
  code: ChatErrorCode;
  message?: string;
  status?: number;
  retryAfterMs?: number;
};
export type FeedbackRating = 'up' | 'down';

export type ToolLine = {
  call_id: string;
  tool: string;
  label: string;
  status: 'running' | 'ok' | 'failed';
  summary?: string;
};

export type UserChatMessage = {
  kind: 'user';
  id: string;
  content: string;
  attachments: AssistantAttachment[];
  status: 'sent' | 'failed';
};

export type AssistantChatMessage = {
  kind: 'assistant';
  id: string;
  text: string;
  tools: ToolLine[];
  cards: AssistantCard[];
  actions: AssistantAction[];
  status: 'streaming' | 'done' | 'error';
  error?: ChatError;
  feedback: FeedbackRating | null;
  model?: string;
  /** True once the server has acknowledged this message (`message.created`) or stored it. */
  remote: boolean;
  /** A later turn re-sent the user message after this reply failed: it shows no Retry button. */
  retried?: boolean;
};

export type ChatMessage = UserChatMessage | AssistantChatMessage;
export type ChatState = { messages: ChatMessage[] };

export const initialChatState: ChatState = { messages: [] };

export type ChatAction =
  | { type: 'reset' }
  | { type: 'hydrate'; detail: Schemas['AssistantThreadDetail'] }
  | {
      type: 'send';
      userId: string;
      assistantId: string;
      content: string;
      attachments: AssistantAttachment[];
      /**
       * Re-sends the last user message. A turn the server never stored (failed before
       * `message.created`) is replaced; a stored one stays and a new turn is appended.
       */
      retry?: boolean;
    }
  | { type: 'event'; event: AssistantStreamEvent }
  | { type: 'failed'; error: ChatError }
  | { type: 'actionUpdated'; action: AssistantAction }
  | { type: 'feedback'; messageId: string; rating: FeedbackRating | null };

const streamingIndex = (messages: ChatMessage[]) => {
  const last = messages.length - 1;
  const message = messages[last];
  return message?.kind === 'assistant' && message.status === 'streaming'
    ? last
    : -1;
};

function patchStreaming(
  state: ChatState,
  patch: (message: AssistantChatMessage) => AssistantChatMessage,
): ChatState {
  const index = streamingIndex(state.messages);
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages[index] = patch(messages[index] as AssistantChatMessage);
  return { messages };
}

function hydrate(detail: Schemas['AssistantThreadDetail']): ChatState {
  return {
    messages: detail.messages.map((m): ChatMessage => {
      if (m.role === 'user')
        return {
          kind: 'user',
          id: m.id,
          content: m.content,
          attachments: m.attachments,
          status: 'sent',
        };
      return {
        kind: 'assistant',
        id: m.id,
        text: m.content,
        tools: m.tool_calls.map((call) => ({
          call_id: call.call_id,
          tool: call.tool,
          label: call.summary_vi,
          status: call.ok ? 'ok' : 'failed',
          summary: call.summary_vi,
        })),
        cards: m.cards,
        actions: detail.actions.filter((a) => a.message_id === m.id),
        status: 'done',
        feedback: m.feedback?.rating ?? null,
        ...(m.model ? { model: m.model } : {}),
        remote: true,
      };
    }),
  };
}

function applyEvent(state: ChatState, event: AssistantStreamEvent): ChatState {
  switch (event.event) {
    case 'message.created':
      return patchStreaming(state, (m) => ({
        ...m,
        id: event.data.message_id,
        remote: true,
      }));
    case 'message.delta':
      return patchStreaming(state, (m) => ({
        ...m,
        text: m.text + event.data.text,
      }));
    case 'tool.started':
      return patchStreaming(state, (m) => ({
        ...m,
        tools: [
          ...m.tools,
          {
            call_id: event.data.call_id,
            tool: event.data.tool,
            label: event.data.label_vi,
            status: 'running',
          },
        ],
      }));
    case 'tool.finished':
      return patchStreaming(state, (m) => {
        const status = event.data.ok ? 'ok' : 'failed';
        const known = m.tools.some((t) => t.call_id === event.data.call_id);
        return {
          ...m,
          tools: known
            ? m.tools.map((t) =>
                t.call_id === event.data.call_id
                  ? { ...t, status, summary: event.data.summary_vi }
                  : t,
              )
            : [
                ...m.tools,
                {
                  call_id: event.data.call_id,
                  tool: event.data.tool,
                  label: event.data.summary_vi,
                  status,
                  summary: event.data.summary_vi,
                },
              ],
        };
      });
    case 'card':
      return patchStreaming(state, (m) => ({
        ...m,
        cards: [...m.cards, event.data],
      }));
    case 'action.proposed':
      return patchStreaming(state, (m) => ({
        ...m,
        actions: [
          ...m.actions.filter((a) => a.id !== event.data.id),
          event.data,
        ],
      }));
    case 'message.completed':
      return patchStreaming(state, (m) => ({
        ...m,
        status: 'done',
        model: event.data.model,
        remote: true,
      }));
    case 'error':
      return patchStreaming(state, (m) => ({
        ...m,
        status: 'error',
        error: { code: event.data.code, message: event.data.message_vi },
      }));
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'hydrate':
      return hydrate(action.detail);
    case 'send': {
      let messages = state.messages;
      if (action.retry) {
        let lastUser = messages.length - 1;
        while (lastUser >= 0 && messages[lastUser].kind !== 'user') lastUser--;
        const reply = messages[lastUser + 1];
        if (lastUser >= 0 && reply?.kind === 'assistant' && reply.remote)
          messages = messages.map((m, i) =>
            i === lastUser + 1 ? { ...reply, retried: true } : m,
          );
        else if (lastUser >= 0) messages = messages.slice(0, lastUser);
      }
      return {
        messages: [
          ...messages,
          {
            kind: 'user',
            id: action.userId,
            content: action.content,
            attachments: action.attachments,
            status: 'sent',
          },
          {
            kind: 'assistant',
            id: action.assistantId,
            text: '',
            tools: [],
            cards: [],
            actions: [],
            status: 'streaming',
            feedback: null,
            remote: false,
          },
        ],
      };
    }
    case 'event':
      return applyEvent(state, action.event);
    case 'failed': {
      const index = streamingIndex(state.messages);
      if (index < 0) return state;
      const messages = state.messages.slice();
      const reply = messages[index] as AssistantChatMessage;
      messages[index] = { ...reply, status: 'error', error: action.error };
      const user = messages[index - 1];
      if (!reply.remote && user?.kind === 'user')
        messages[index - 1] = { ...user, status: 'failed' };
      return { messages };
    }
    case 'actionUpdated': {
      let changed = false;
      const messages = state.messages.map((m) => {
        if (
          m.kind !== 'assistant' ||
          !m.actions.some((a) => a.id === action.action.id)
        )
          return m;
        changed = true;
        return {
          ...m,
          actions: m.actions.map((a) =>
            a.id === action.action.id ? action.action : a,
          ),
        };
      });
      return changed ? { messages } : state;
    }
    case 'feedback':
      return {
        messages: state.messages.map((m) =>
          m.kind === 'assistant' && m.id === action.messageId
            ? { ...m, feedback: action.rating }
            : m,
        ),
      };
  }
}
