import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { setAnalyticsSink } from '@/lib/analytics';
import { getApiClient, setApiTransport } from '@/lib/api/client';
import { newUuid } from '@/lib/uuid';
import { createTestQueryClient } from '@/test/render';
import {
  createMockFetch,
  proposalReply,
  quotaReply,
  setNextAssistantReply,
} from '@/test/mock';

import type { AssistantAction } from '@taphoa/api-client';

import { assistantKeys } from './api';
import type { AssistantChatMessage } from './chatReducer';
import { useAssistantChat } from './useAssistantChat';

const sink = { capture: jest.fn() };
beforeEach(() => {
  sink.capture.mockClear();
  setAnalyticsSink(sink);
});
afterEach(() => setAnalyticsSink(null));

async function newThread() {
  const created = await getApiClient().raw.POST('/v1/assistant/threads', {
    body: {},
  });
  return created.data!.id;
}

function setup(
  threadId: string | undefined,
  queryClient = createTestQueryClient(),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ id }: { id: string | undefined }) =>
      useAssistantChat({ threadId: id, language: 'vi' }),
    { wrapper, initialProps: { id: threadId } },
  );
}

const lastAssistant = (messages: { kind: string }[]) =>
  messages[messages.length - 1] as AssistantChatMessage;

test('streams a canned reply, then keeps it stable when the thread refetches', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Doanh thu?', { input: 'voice' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  const [user, reply] = hook.result.current.messages;
  expect(user).toMatchObject({ kind: 'user', content: 'Doanh thu?' });
  expect(reply).toMatchObject({
    kind: 'assistant',
    status: 'done',
    text: 'Hôm nay cửa hàng có doanh thu 1.234.000 ₫.',
    tools: [{ status: 'ok', summary: 'Doanh thu hôm nay: 1.234.000 ₫' }],
  });
  const ids = hook.result.current.messages.map((m) => m.id);
  // The server stored both messages; a refetch must not duplicate them.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(hook.result.current.messages.map((m) => m.id)).toEqual(ids);
  expect(sink.capture).toHaveBeenCalledWith('assistant_message_sent', {
    input: 'voice',
    thread_turn: 1,
  });
  expect(sink.capture).toHaveBeenCalledWith('assistant_reply_received', {
    latency_ms: expect.any(Number),
    tools_count: 1,
    error_code: null,
  });
});

test('hydrates existing messages once and counts turns', async () => {
  const id = await newThread();
  const first = await setup(id);
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await act(async () => {
    first.result.current.send('Một', { input: 'text' });
  });
  await waitFor(() => expect(first.result.current.streaming).toBe(false));
  await first.unmount();
  const again = await setup(id);
  await waitFor(() => expect(again.result.current.messages).toHaveLength(2));
  expect(again.result.current.messages[1]).toMatchObject({ status: 'done' });
  sink.capture.mockClear();
  await act(async () => {
    again.result.current.send('Hai', { input: 'text' });
  });
  await waitFor(() => expect(again.result.current.streaming).toBe(false));
  expect(sink.capture).toHaveBeenCalledWith('assistant_message_sent', {
    input: 'text',
    thread_turn: 2,
  });
});

test('a proposal reply carries a card and an action; updateAction and setFeedback update it', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  setNextAssistantReply(proposalReply());
  await act(async () => {
    hook.result.current.send('nhập mì', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  const reply = lastAssistant(hook.result.current.messages);
  expect(reply.cards).toHaveLength(1);
  expect(reply.actions).toHaveLength(1);
  const updated: AssistantAction = { ...reply.actions[0], status: 'done' };
  await act(async () => hook.result.current.updateAction(updated));
  expect(lastAssistant(hook.result.current.messages).actions[0].status).toBe(
    'done',
  );
  await act(async () => hook.result.current.setFeedback(reply.id, 'up'));
  expect(lastAssistant(hook.result.current.messages).feedback).toBe('up');
});

test('a quota reply shows the error and reports its code', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  setNextAssistantReply(quotaReply());
  await act(async () => {
    hook.result.current.send('Hỏi', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(lastAssistant(hook.result.current.messages)).toMatchObject({
    status: 'error',
    error: { code: 'quota' },
  });
  expect(sink.capture).toHaveBeenCalledWith('assistant_reply_received', {
    latency_ms: expect.any(Number),
    tools_count: 0,
    error_code: 'quota',
  });
});

test('a non-OK response fails the turn; retry sends the message as a new turn', async () => {
  const hook = await setup(newUuid());
  // The thread does not exist: its query fails, and the chat then works without history.
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Xin chào', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(hook.result.current.messages[0]).toMatchObject({ status: 'failed' });
  expect(lastAssistant(hook.result.current.messages)).toMatchObject({
    status: 'error',
    error: { code: 'network' },
  });
  expect(sink.capture).toHaveBeenCalledWith(
    'assistant_reply_received',
    expect.objectContaining({ error_code: 'internal' }),
  );
});

test('retry resends the last user message', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  setNextAssistantReply(quotaReply());
  await act(async () => {
    hook.result.current.send('Hỏi lại', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  await act(async () => {
    hook.result.current.retry();
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  // The mock server keeps the refused first user message, and the idle chat now shows the
  // server's list: that user message, then the retried turn.
  expect(hook.result.current.messages).toHaveLength(3);
  expect(lastAssistant(hook.result.current.messages).status).toBe('done');
  expect(sink.capture).toHaveBeenLastCalledWith(
    'assistant_reply_received',
    expect.objectContaining({ error_code: null }),
  );
  // Nothing to retry in an empty chat.
  const empty = await setup(id);
  await act(async () => empty.result.current.retry());
  expect(empty.result.current.streaming).toBe(false);
});

test('a stream cut mid-reply becomes an interrupted error and is not re-sent', async () => {
  const id = await newThread();
  const inner = createMockFetch();
  let posts = 0;
  setApiTransport(async (input, init) => {
    const response = await inner(input, init);
    const req = input as Request;
    if (req.method !== 'POST' || !req.url.endsWith('/messages'))
      return response;
    posts++;
    const text = await response.text();
    const cut = text.slice(0, text.indexOf('event: message.completed'));
    return new Response(cut, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Hỏi', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(lastAssistant(hook.result.current.messages)).toMatchObject({
    status: 'error',
    error: { code: 'interrupted' },
  });
  expect(lastAssistant(hook.result.current.messages).text).not.toBe('');
  expect(posts).toBe(1);
  setApiTransport(createMockFetch());
});

test('unmounting aborts the stream quietly', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Hỏi', { input: 'text' });
  });
  await hook.unmount();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(sink.capture).not.toHaveBeenCalledWith(
    'assistant_reply_received',
    expect.objectContaining({ error_code: expect.anything() }),
  );
});

test('changing thread resets the chat', async () => {
  const a = await newThread();
  const b = await newThread();
  const hook = await setup(a);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Hỏi', { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(hook.result.current.messages).toHaveLength(2);
  await hook.rerender({ id: b });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.messages).toHaveLength(0);
});

async function sendAndSettle(
  hook: Awaited<ReturnType<typeof setup>>,
  content: string,
) {
  await act(async () => {
    hook.result.current.send(content, { input: 'text' });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
}

async function sendThroughClient(id: string, content: string) {
  const sent = await getApiClient().sendAssistantMessage(id, {
    content,
    language: 'vi',
  });
  for await (const event of sent.events!) void event;
}

test('reopening a thread within the cache lifetime shows every turn', async () => {
  const id = await newThread();
  const queryClient = createTestQueryClient();
  const first = await setup(id, queryClient);
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await sendAndSettle(first, 'Một');
  await first.unmount();
  const second = await setup(id, queryClient);
  await waitFor(() => expect(second.result.current.messages).toHaveLength(2));
  await sendAndSettle(second, 'Hai');
  await second.unmount();
  const third = await setup(id, queryClient);
  await waitFor(() => expect(third.result.current.messages).toHaveLength(4));
  expect(third.result.current.messages[2]).toMatchObject({ content: 'Hai' });
});

test('switching threads and back shows the turns of the first thread', async () => {
  const a = await newThread();
  const b = await newThread();
  const hook = await setup(a);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await sendAndSettle(hook, 'Một');
  await hook.rerender({ id: b });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.messages).toHaveLength(0);
  await hook.rerender({ id: a });
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(2));
  expect(hook.result.current.messages[0]).toMatchObject({ content: 'Một' });
});

test('fresh server data re-hydrates an idle chat', async () => {
  const id = await newThread();
  const queryClient = createTestQueryClient();
  const hook = await setup(id, queryClient);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await sendThroughClient(id, 'Từ máy khác');
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: assistantKeys.thread(id) });
  });
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(2));
  expect(hook.result.current.messages[0]).toMatchObject({
    content: 'Từ máy khác',
  });
});

test('a refetch that lands during a turn does not replace it', async () => {
  const id = await newThread();
  const queryClient = createTestQueryClient();
  const hook = await setup(id, queryClient);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    hook.result.current.send('Hỏi', { input: 'text' });
    await queryClient.invalidateQueries({ queryKey: assistantKeys.thread(id) });
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(hook.result.current.messages).toHaveLength(2);
  expect(hook.result.current.messages[1]).toMatchObject({ status: 'done' });
});

test('a send while the thread is loading is refused and never skips hydration', async () => {
  const id = await newThread();
  await sendThroughClient(id, 'Cũ');
  const inner = createMockFetch();
  let releaseThread!: () => void;
  const threadReady = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  setApiTransport(async (input, init) => {
    const req = input as Request;
    if (req.method === 'GET' && req.url.endsWith(`/threads/${id}`)) {
      await threadReady;
    }
    return inner(input, init);
  });
  // Async renderHook flushes effects: the zero-latency query can otherwise finish
  // before it returns. Hold the response until the early send has been checked.
  try {
    const hook = await setup(id);
    expect(hook.result.current.loading).toBe(true);
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = hook.result.current.send('Quá sớm', { input: 'text' });
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.messages).toHaveLength(0);
    await act(async () => releaseThread());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages).toHaveLength(2);
    expect(hook.result.current.messages[0]).toMatchObject({ content: 'Cũ' });
    await act(async () => {
      accepted = hook.result.current.send('Đúng lúc', { input: 'text' });
    });
    expect(accepted).toBe(true);
    await waitFor(() => expect(hook.result.current.streaming).toBe(false));
    expect(hook.result.current.messages).toHaveLength(4);
  } finally {
    releaseThread();
    setApiTransport(inner);
  }
});

test('a second send while a turn runs is refused', async () => {
  const id = await newThread();
  const hook = await setup(id);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const results: boolean[] = [];
  await act(async () => {
    results.push(hook.result.current.send('Một', { input: 'text' }));
    results.push(hook.result.current.send('Hai', { input: 'text' }));
  });
  expect(results).toEqual([true, false]);
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  expect(hook.result.current.messages).toHaveLength(2);
});

test('retry after a mid-stream error keeps the stored turn, so a reload shows the same list', async () => {
  const id = await newThread();
  const inner = createMockFetch();
  let cut = true;
  setApiTransport(async (input, init) => {
    const response = await inner(input, init);
    const req = input as Request;
    if (!cut || req.method !== 'POST' || !req.url.endsWith('/messages'))
      return response;
    cut = false;
    const text = await response.text();
    return new Response(
      text.slice(0, text.indexOf('event: message.completed')),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  });
  const queryClient = createTestQueryClient();
  const hook = await setup(id, queryClient);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await sendAndSettle(hook, 'Hỏi');
  expect(lastAssistant(hook.result.current.messages).status).toBe('error');
  await act(async () => {
    hook.result.current.retry();
  });
  await waitFor(() => expect(hook.result.current.streaming).toBe(false));
  const local = hook.result.current.messages;
  expect(local.map((m) => m.kind)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(local[1]).toMatchObject({ status: 'error', retried: true });
  expect(lastAssistant(local).status).toBe('done');
  await hook.unmount();
  const reload = await setup(id, queryClient);
  await waitFor(() => expect(reload.result.current.messages).toHaveLength(4));
  const shape = (list: typeof local) =>
    list.map((m) => (m.kind === 'user' ? m.content : m.text));
  expect(shape(reload.result.current.messages)).toEqual(shape(local));
  setApiTransport(createMockFetch());
});

describe('an HTTP error on the messages request (#158)', () => {
  afterEach(() => setApiTransport(createMockFetch()));

  async function sendWithStatus(status: number) {
    const inner = createMockFetch();
    setApiTransport(async (input, init) => {
      const req = input as Request;
      if (req.method === 'POST' && req.url.endsWith('/messages'))
        return new Response(JSON.stringify({ error: 'edge' }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      return inner(input, init);
    });
    const hook = await setup(await newThread());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      hook.result.current.send('Xin chào', { input: 'text' });
    });
    await waitFor(() => expect(hook.result.current.streaming).toBe(false));
    return lastAssistant(hook.result.current.messages);
  }

  test('429 is the quota, not the network', async () => {
    expect((await sendWithStatus(429)).error).toEqual({ code: 'quota' });
    expect(sink.capture).toHaveBeenCalledWith(
      'assistant_reply_received',
      expect.objectContaining({ error_code: 'quota' }),
    );
  });

  test.each([502, 503, 504])('%i is a busy server', async (status) => {
    expect((await sendWithStatus(status)).error).toEqual({ code: 'busy' });
  });

  test('500 is a generic fault', async () => {
    expect((await sendWithStatus(500)).error).toEqual({ code: 'internal' });
  });
});
