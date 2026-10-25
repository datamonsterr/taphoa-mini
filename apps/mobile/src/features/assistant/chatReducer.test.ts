import type {
  AssistantAction,
  AssistantCard,
  AssistantStreamEvent,
  components,
} from '@taphoa/api-client';

import {
  chatReducer,
  initialChatState,
  type AssistantChatMessage,
  type ChatState,
} from './chatReducer';

type Detail = components['schemas']['AssistantThreadDetail'];

const action = (over: Partial<AssistantAction> = {}): AssistantAction => ({
  id: 'a1',
  thread_id: 't1',
  message_id: 'm-real',
  kind: 'stock_adjustment',
  status: 'proposed',
  payload: {},
  summary_vi: 'Thêm 12 gói',
  proposed_by: 'u1',
  decided_by: null,
  decided_at: null,
  result: null,
  error: null,
  expires_at: '2030-01-01T00:00:00Z',
  created_at: '2030-01-01T00:00:00Z',
  ...over,
});

const sent = (): ChatState =>
  chatReducer(initialChatState, {
    type: 'send',
    userId: 'u-local',
    assistantId: 'a-local',
    content: 'Doanh thu?',
    attachments: [],
  });
const ev = (state: ChatState, event: AssistantStreamEvent) =>
  chatReducer(state, { type: 'event', event });
const last = (state: ChatState) =>
  state.messages[state.messages.length - 1] as AssistantChatMessage;

test('send adds the user message and a streaming placeholder', () => {
  const state = sent();
  expect(state.messages).toEqual([
    {
      kind: 'user',
      id: 'u-local',
      content: 'Doanh thu?',
      attachments: [],
      status: 'sent',
    },
    expect.objectContaining({
      kind: 'assistant',
      id: 'a-local',
      text: '',
      status: 'streaming',
      tools: [],
      cards: [],
      actions: [],
      feedback: null,
    }),
  ]);
});

test('every stream event updates the assistant message', () => {
  let s = sent();
  s = ev(s, {
    event: 'message.created',
    data: { message_id: 'm-real', thread_id: 't1' },
  });
  expect(last(s).id).toBe('m-real');
  s = ev(s, { event: 'message.delta', data: { text: 'Xin ' } });
  s = ev(s, { event: 'message.delta', data: { text: 'chào' } });
  expect(last(s).text).toBe('Xin chào');
  s = ev(s, {
    event: 'tool.started',
    data: { call_id: 'c1', tool: 'get_sales', label_vi: 'Đang xem…' },
  });
  expect(last(s).tools).toEqual([
    { call_id: 'c1', tool: 'get_sales', label: 'Đang xem…', status: 'running' },
  ]);
  s = ev(s, {
    event: 'tool.finished',
    data: { call_id: 'c1', tool: 'get_sales', ok: true, summary_vi: 'Xong' },
  });
  expect(last(s).tools[0]).toMatchObject({ status: 'ok', summary: 'Xong' });
  s = ev(s, {
    event: 'tool.started',
    data: { call_id: 'c2', tool: 'x', label_vi: 'x…' },
  });
  s = ev(s, {
    event: 'tool.finished',
    data: { call_id: 'c2', tool: 'x', ok: false, summary_vi: 'Lỗi' },
  });
  expect(last(s).tools[1].status).toBe('failed');
  s = ev(s, {
    event: 'tool.finished',
    data: { call_id: 'c3', tool: 'late', ok: true, summary_vi: 'Muộn' },
  });
  expect(last(s).tools).toHaveLength(3);
  const card: AssistantCard = { type: 'debt_list', items: [] };
  s = ev(s, { event: 'card', data: card });
  expect(last(s).cards).toEqual([card]);
  s = ev(s, { event: 'action.proposed', data: action() });
  s = ev(s, { event: 'action.proposed', data: action({ summary_vi: 'Mới' }) });
  expect(last(s).actions).toHaveLength(1);
  expect(last(s).actions[0].summary_vi).toBe('Mới');
  s = ev(s, {
    event: 'message.completed',
    data: {
      message_id: 'm-real',
      model: 'm/x',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });
  expect(last(s)).toMatchObject({ status: 'done', model: 'm/x' });
});

test('a quota error ends the reply with the server message', () => {
  const s = ev(sent(), {
    event: 'error',
    data: { code: 'quota', message_vi: 'Hết lượt' },
  });
  expect(last(s)).toMatchObject({
    status: 'error',
    error: { code: 'quota', message: 'Hết lượt' },
  });
  expect(s.messages[0]).toMatchObject({ status: 'sent' });
});

test('an interrupted stream keeps the partial text', () => {
  let s = ev(sent(), {
    event: 'message.created',
    data: { message_id: 'm-real', thread_id: 't1' },
  });
  s = ev(s, { event: 'message.delta', data: { text: 'Một nửa' } });
  s = chatReducer(s, { type: 'failed', error: { code: 'interrupted' } });
  expect(last(s)).toMatchObject({
    status: 'error',
    text: 'Một nửa',
    error: { code: 'interrupted' },
  });
  expect(s.messages[0]).toMatchObject({ status: 'sent' });
});

test('a failure before the server accepted the turn fails the user message', () => {
  const s = chatReducer(sent(), {
    type: 'failed',
    error: { code: 'network', message: 'offline' },
  });
  expect(s.messages[0]).toMatchObject({ status: 'failed' });
  expect(last(s).error).toEqual({ code: 'network', message: 'offline' });
});

test('events and failures without a streaming reply are ignored', () => {
  expect(
    ev(initialChatState, { event: 'message.delta', data: { text: 'x' } }),
  ).toBe(initialChatState);
  expect(
    chatReducer(initialChatState, {
      type: 'failed',
      error: { code: 'network' },
    }),
  ).toBe(initialChatState);
  const done = ev(
    ev(sent(), {
      event: 'message.completed',
      data: {
        message_id: 'm',
        model: 'x',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    { event: 'message.delta', data: { text: 'late' } },
  );
  expect(last(done).text).toBe('');
});

test('retry replaces the failed turn instead of stacking it', () => {
  let s = chatReducer(sent(), { type: 'failed', error: { code: 'network' } });
  s = chatReducer(s, {
    type: 'send',
    userId: 'u2',
    assistantId: 'a2',
    content: 'Doanh thu?',
    attachments: [],
    retry: true,
  });
  expect(s.messages.map((m) => m.id)).toEqual(['u2', 'a2']);
});

test('hydrate maps server messages, tool calls and actions', () => {
  const detail: Detail = {
    thread: {
      id: 't1',
      title: null,
      context: null,
      created_at: '2030-01-01T00:00:00Z',
      updated_at: '2030-01-01T00:00:00Z',
    },
    messages: [
      {
        id: 'mu',
        thread_id: 't1',
        role: 'user',
        content: 'Hi',
        attachments: [{ receipt_id: 'r1' }],
        tool_calls: [],
        cards: [],
        model: null,
        feedback: null,
        created_at: '2030-01-01T00:00:00Z',
      },
      {
        id: 'm-real',
        thread_id: 't1',
        role: 'assistant',
        content: 'Chào',
        attachments: [],
        tool_calls: [
          { call_id: 'c1', tool: 'a', ok: true, summary_vi: 'Tốt' },
          { call_id: 'c2', tool: 'b', ok: false, summary_vi: 'Hỏng' },
        ],
        cards: [{ type: 'debt_list', items: [] }],
        model: 'm/x',
        feedback: { rating: 'down' },
        created_at: '2030-01-01T00:00:01Z',
      },
    ],
    actions: [action()],
  };
  const s = chatReducer(initialChatState, { type: 'hydrate', detail });
  expect(s.messages[0]).toEqual({
    kind: 'user',
    id: 'mu',
    content: 'Hi',
    attachments: [{ receipt_id: 'r1' }],
    status: 'sent',
  });
  expect(last(s)).toMatchObject({
    id: 'm-real',
    text: 'Chào',
    status: 'done',
    model: 'm/x',
    feedback: 'down',
    tools: [
      { call_id: 'c1', status: 'ok', summary: 'Tốt' },
      { call_id: 'c2', status: 'failed', summary: 'Hỏng' },
    ],
  });
  expect(last(s).actions).toHaveLength(1);
});

test('actionUpdated replaces the action wherever it is', () => {
  let s = ev(sent(), { event: 'action.proposed', data: action() });
  s = chatReducer(s, {
    type: 'actionUpdated',
    action: action({ status: 'done' }),
  });
  expect(last(s).actions[0].status).toBe('done');
  const same = chatReducer(s, {
    type: 'actionUpdated',
    action: action({ id: 'other' }),
  });
  expect(same).toBe(s);
});

test('feedback sets and clears the rating on one message', () => {
  const s = ev(sent(), {
    event: 'message.created',
    data: { message_id: 'm-real', thread_id: 't1' },
  });
  const rated = chatReducer(s, {
    type: 'feedback',
    messageId: 'm-real',
    rating: 'up',
  });
  expect(last(rated).feedback).toBe('up');
  expect(
    chatReducer(rated, { type: 'feedback', messageId: 'm-real', rating: null })
      .messages[1],
  ).toMatchObject({ feedback: null });
});

test('reset empties the chat', () => {
  expect(chatReducer(sent(), { type: 'reset' })).toBe(initialChatState);
});
