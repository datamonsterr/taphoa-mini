import {
  createApiClient,
  readAssistantStream,
  type AssistantStreamEvent,
} from '@taphoa/api-client';
import {
  createMockFetch,
  resetMockDb,
  setNextAssistantReply,
  quotaReply,
  proposalReply,
  getMockDb,
} from './index';
import { registerImage } from './db';
import { createReceipt, getReceipt } from './stockReceipts';

const api = () =>
  createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch() });
async function collect<T>(events: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function thread() {
  const result = await api().raw.POST('/v1/assistant/threads', {
    body: { title: 'Doanh thu', context: { screen: 'camera' } },
  });
  expect(result.response.status).toBe(201);
  return result.data!.id;
}
async function reply(id: string) {
  const result = await api().sendAssistantMessage(id, {
    content: 'Hôm nay bán được bao nhiêu?',
    language: 'vi',
  });
  expect(result.response.headers.get('content-type')).toBe('text/event-stream');
  return collect(result.events!);
}
beforeEach(resetMockDb);

test('streams a canned reply end to end and stores both messages', async () => {
  const id = await thread();
  const result = await api().sendAssistantMessage(id, {
    content: 'Doanh thu?',
    language: 'vi',
  });
  const events = await collect(result.events!);
  expect(events.map((e) => e.event)).toEqual([
    'message.created',
    'tool.started',
    'tool.finished',
    'message.delta',
    'message.delta',
    'message.delta',
    'message.completed',
  ]);
  const text = events
    .flatMap((e) => (e.event === 'message.delta' ? [e.data.text] : []))
    .join('');
  expect(text).toBe('Hôm nay cửa hàng có doanh thu 1.234.000 ₫.');
  const detail = await api().raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId: id } },
  });
  expect(detail.data!.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(detail.data!.messages[1]!.content).toBe(text);
  expect(detail.data!.messages[1]!.model).toBe('mock/assistant');
  expect(detail.data!.messages[1]!.tool_calls).toHaveLength(1);
});

test('quota preset yields one terminal Vietnamese error and the next reply resets', async () => {
  const id = await thread();
  setNextAssistantReply(quotaReply());
  const events = await reply(id);
  expect(events).toEqual([
    {
      event: 'error',
      data: { code: 'quota', message_vi: 'Bạn đã hết lượt trợ lý hôm nay.' },
    },
  ]);
  expect((await reply(id)).at(-1)?.event).toBe('message.completed');
});

test('proposal confirm is idempotent and reject after decision conflicts', async () => {
  const id = await thread();
  setNextAssistantReply(proposalReply());
  const events = await reply(id);
  const proposal = events.find(
    (e): e is Extract<AssistantStreamEvent, { event: 'action.proposed' }> =>
      e.event === 'action.proposed',
  )!;
  expect(
    events.some((e) => e.event === 'card' && e.data.type === 'restock_list'),
  ).toBe(true);
  expect(proposal.data.thread_id).toBe(id);
  const path = { actionId: proposal.data.id };
  const fetch = createMockFetch();
  expect(
    (
      await fetch(
        `http://mock.local/v1/assistant/actions/${path.actionId}/confirm`,
        { method: 'POST' },
      )
    ).status,
  ).toBe(400);
  const confirm = () =>
    api().raw.POST('/v1/assistant/actions/{actionId}/confirm', {
      params: { path, header: { 'Idempotency-Key': 'confirm-1' } },
    });
  const first = await confirm();
  expect(first.data!.status).toBe('done');
  expect((await confirm()).data).toEqual(first.data);
  const reject = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/reject',
    { params: { path } },
  );
  expect(reject.response.status).toBe(409);
  expect(reject.error?.code).toBe('already_decided');
  const again = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/confirm',
    { params: { path, header: { 'Idempotency-Key': 'different' } } },
  );
  expect(again.error?.code).toBe('already_decided');
});

test('expired proposal cannot be confirmed or rejected', async () => {
  const id = await thread();
  const script = proposalReply();
  // Presets are event arrays; callers can script failures and expired proposals.
  for (const event of script)
    if (event.event === 'action.proposed')
      event.data.expires_at = '2000-01-01T00:00:00Z';
  setNextAssistantReply(script);
  const events = await reply(id);
  const proposal = events.find((e) => e.event === 'action.proposed')!;
  const path = {
    actionId: (
      proposal.data as Extract<
        AssistantStreamEvent,
        { event: 'action.proposed' }
      >['data']
    ).id,
  };
  const confirm = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/confirm',
    { params: { path, header: { 'Idempotency-Key': 'expired' } } },
  );
  expect(confirm.error?.code).toBe('action_stale');
  const reject = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/reject',
    { params: { path } },
  );
  expect(reject.error?.code).toBe('action_stale');
});

test('next steps are server chips, digest supports missing dates, devices upsert and delete', async () => {
  const steps = await api().raw.GET('/v1/assistant/next-steps', {
    params: { query: { screen: 'camera' } },
  });
  expect(steps.data!.items.length).toBeLessThanOrEqual(8);
  expect(steps.data!.items.map((s) => s.kind)).toEqual([
    'restock',
    'draft_receipts',
  ]);
  const digest = await api().raw.GET('/v1/assistant/digest');
  expect(digest.data!.sales.revenue).toBe(1234000);
  expect(digest.data!.read_at).toBeNull();
  const secondDigest = await api().raw.GET('/v1/assistant/digest');
  expect(secondDigest.data!.read_at).not.toBeNull();
  expect(
    (
      await api().raw.GET('/v1/assistant/digest', {
        params: { query: { business_date: '2000-01-01' } },
      })
    ).response.status,
  ).toBe(404);
  const body = {
    token: 'ExponentPushToken[example]',
    platform: 'android' as const,
    app_version: '1.0',
    language: 'vi' as const,
  };
  const first = await api().raw.POST('/v1/devices', { body });
  const second = await api().raw.POST('/v1/devices', {
    body: { ...body, app_version: '2.0' },
  });
  expect(first.response.status).toBe(200);
  expect(second.data!.created_at).toBe(first.data!.created_at);
  expect(second.data!.app_version).toBe('2.0');
  for (let i = 0; i < 2; i++)
    expect(
      (
        await api().raw.DELETE('/v1/devices/{token}', {
          params: { path: { token: body.token } },
        })
      ).response.status,
    ).toBe(204);
});

test('threads are private, paginated, deletable and feedback is persisted', async () => {
  const id = await thread();
  await reply(id);
  const detail = await api().raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId: id } },
  });
  const messageId = detail.data!.messages[1]!.id;
  expect(
    (
      await api().raw.POST('/v1/assistant/messages/{messageId}/feedback', {
        params: { path: { messageId } },
        body: { rating: 'up', comment: 'Hữu ích' },
      })
    ).response.status,
  ).toBe(204);
  expect(
    (
      await api().raw.GET('/v1/assistant/threads/{threadId}', {
        params: { path: { threadId: id } },
      })
    ).data!.messages[1]!.feedback,
  ).toEqual({ rating: 'up', comment: 'Hữu ích' });
  const nextId = await thread();
  const page = await api().raw.GET('/v1/assistant/threads', {
    params: { query: { limit: 1 } },
  });
  expect(page.data!.items[0]!.id).toBe(nextId);
  expect(page.data!.next_cursor).toBe('1');
  const member = getMockDb().currentMemberId;
  getMockDb().currentMemberId = getMockDb().members.find(
    (m) => m.id !== member,
  )!.id;
  expect((await api().raw.GET('/v1/assistant/threads')).data!.items).toEqual(
    [],
  );
  expect(
    (
      await api().raw.GET('/v1/assistant/threads/{threadId}', {
        params: { path: { threadId: id } },
      })
    ).response.status,
  ).toBe(404);
  getMockDb().currentMemberId = member;
  expect(
    (
      await api().raw.DELETE('/v1/assistant/threads/{threadId}', {
        params: { path: { threadId: id } },
      })
    ).response.status,
  ).toBe(204);
  expect(
    (
      await api().raw.GET('/v1/assistant/threads/{threadId}', {
        params: { path: { threadId: id } },
      })
    ).response.status,
  ).toBe(404);
  resetMockDb();
  expect((await api().raw.GET('/v1/assistant/threads')).data!.items).toEqual(
    [],
  );
});

test.each([
  { content: '', language: 'vi' },
  { content: 'x'.repeat(4001), language: 'vi' },
  { content: 'x', language: 'fr' },
  { content: 'x', language: 'vi', attachments: [{}] },
  { content: 'x', language: 'vi', attachments: [{ image_id: 'invalid' }] },
  {
    content: 'x',
    language: 'vi',
    attachments: [
      {
        image_id: '00000000-0000-4000-8000-000000000001',
        receipt_id: '00000000-0000-4000-8000-000000000002',
      },
    ],
  },
])('invalid message returns JSON 400 before streaming: %j', async (body) => {
  const id = await thread();
  const res = await createMockFetch()(
    `http://mock.local/v1/assistant/threads/${id}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('validation_failed');
});

test('a rejected action stays already_decided after its expiry time', async () => {
  const id = await thread();
  const script = proposalReply();
  const proposed = script.find((e) => e.event === 'action.proposed')!;
  const expiry = (
    proposed.data as Extract<
      AssistantStreamEvent,
      { event: 'action.proposed' }
    >['data']
  ).expires_at;
  setNextAssistantReply(script);
  const events = await reply(id);
  const action = events.find((e) => e.event === 'action.proposed')!;
  const path = {
    actionId: (
      action.data as Extract<
        AssistantStreamEvent,
        { event: 'action.proposed' }
      >['data']
    ).id,
  };
  const rejected = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/reject',
    { params: { path } },
  );
  expect(rejected.data!.status).toBe('rejected');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(expiry) + 1);
  try {
    const result = await api().raw.POST(
      '/v1/assistant/actions/{actionId}/confirm',
      { params: { path, header: { 'Idempotency-Key': 'after-reject' } } },
    );
    expect(result.error?.code).toBe('already_decided');
  } finally {
    clock.mockRestore();
  }
});

test('raw mock SSE response is readable with readAssistantStream', async () => {
  const id = await thread();
  const result = await api().raw.POST(
    '/v1/assistant/threads/{threadId}/messages',
    {
      params: { path: { threadId: id } },
      body: { content: 'Chào', language: 'vi' },
      parseAs: 'stream',
    },
  );
  const events = await collect(readAssistantStream(result.response.body!));
  expect(events[0]!.event).toBe('message.created');
  expect(events.at(-1)!.event).toBe('message.completed');
});

type Proposed = Extract<AssistantStreamEvent, { event: 'action.proposed' }>;
const proposalIn = (events: AssistantStreamEvent[]) =>
  events.find((e): e is Proposed => e.event === 'action.proposed')!.data;
const readThread = (threadId: string) =>
  api().raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId } },
  });

test('an action proposed in a reply that does not complete is never stored', async () => {
  const id = await thread();
  const proposal = proposalReply();
  setNextAssistantReply([
    proposal[0]!,
    proposal.find((e) => e.event === 'action.proposed')!,
    ...quotaReply(),
  ]);
  const events = await reply(id);
  expect(events.map((e) => e.event)).toEqual([
    'message.created',
    'action.proposed',
    'error',
  ]);
  const detail = await readThread(id);
  expect(detail.data!.actions).toEqual([]);
  expect(detail.data!.messages.map((m) => m.role)).toEqual(['user']);
  const confirm = await api().raw.POST(
    '/v1/assistant/actions/{actionId}/confirm',
    {
      params: {
        path: { actionId: proposalIn(events).id },
        header: { 'Idempotency-Key': 'never-stored' },
      },
    },
  );
  expect(confirm.response.status).toBe(404);
});

test('a completed reply stores its proposed action with the assistant message', async () => {
  const id = await thread();
  setNextAssistantReply(proposalReply());
  const action = proposalIn(await reply(id));
  const detail = await readThread(id);
  expect(detail.data!.actions.map((a) => a.id)).toEqual([action.id]);
  expect(detail.data!.actions[0]!.message_id).toBe(
    detail.data!.messages[1]!.id,
  );
});

test('a proposal that is already past expires_at reads back as expired', async () => {
  const id = await thread();
  const script = proposalReply();
  for (const event of script)
    if (event.event === 'action.proposed')
      event.data.expires_at = '2000-01-01T00:00:00Z';
  setNextAssistantReply(script);
  await reply(id);
  const detail = await readThread(id);
  expect(detail.data!.actions.map((a) => a.status)).toEqual(['expired']);
});

test.each(['confirm', 'reject'] as const)(
  '%s of a proposal that expired after streaming is stale and marks it expired',
  async (decision) => {
    const id = await thread();
    setNextAssistantReply(proposalReply());
    const action = proposalIn(await reply(id));
    expect((await readThread(id)).data!.actions[0]!.status).toBe('proposed');
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(action.expires_at) + 1);
    try {
      const result =
        decision === 'confirm'
          ? await api().raw.POST('/v1/assistant/actions/{actionId}/confirm', {
              params: {
                path: { actionId: action.id },
                header: { 'Idempotency-Key': 'late' },
              },
            })
          : await api().raw.POST('/v1/assistant/actions/{actionId}/reject', {
              params: { path: { actionId: action.id } },
            });
      expect(result.response.status).toBe(409);
      expect(result.error?.code).toBe('action_stale');
    } finally {
      clock.mockRestore();
    }
    // The status was set when the action was read, so it sticks without the clock.
    expect((await readThread(id)).data!.actions[0]!.status).toBe('expired');
  },
);

test('a proposal is marked expired when the thread is read after expires_at', async () => {
  const id = await thread();
  setNextAssistantReply(proposalReply());
  const action = proposalIn(await reply(id));
  const clock = jest
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(action.expires_at) + 1);
  try {
    expect((await readThread(id)).data!.actions[0]!.status).toBe('expired');
  } finally {
    clock.mockRestore();
  }
});

test('devices are keyed by member and token, and delete only removes the caller registration', async () => {
  // Only fake Date: the mock fetch and streams still need real timers.
  jest.useFakeTimers({
    now: Date.parse('2026-10-25T00:00:00Z'),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  const owner = getMockDb().currentMemberId;
  try {
    const other = getMockDb().members.find((m) => m.id !== owner)!.id;
    const body = {
      token: 'ExponentPushToken[shared]',
      platform: 'ios' as const,
      app_version: '1.0',
      language: 'vi' as const,
    };
    const register = () => api().raw.POST('/v1/devices', { body });
    const remove = () =>
      api().raw.DELETE('/v1/devices/{token}', {
        params: { path: { token: body.token } },
      });
    const first = await register();
    expect(first.data!.created_at).toBe('2026-10-25T00:00:00.000Z');

    jest.setSystemTime(Date.parse('2026-10-25T01:00:00Z'));
    getMockDb().currentMemberId = other;
    // The same token under another member is a separate registration.
    expect((await register()).data!.created_at).toBe(
      '2026-10-25T01:00:00.000Z',
    );
    expect((await remove()).response.status).toBe(204);
    // Deleting an absent registration is still a 204.
    expect((await remove()).response.status).toBe(204);

    jest.setSystemTime(Date.parse('2026-10-25T02:00:00Z'));
    getMockDb().currentMemberId = owner;
    // The first member's registration survived the other member's delete.
    expect((await register()).data!.created_at).toBe(first.data!.created_at);
  } finally {
    getMockDb().currentMemberId = owner;
    jest.useRealTimers();
  }
});

describe('receipt_confirm actions', () => {
  async function proposeReceiptConfirm(receiptId: string) {
    const id = await thread();
    const scripted = proposalReply();
    const base = scripted.find((e) => e.event === 'action.proposed');
    if (base?.event !== 'action.proposed') throw new Error('unreachable');
    setNextAssistantReply([
      scripted[0],
      {
        event: 'action.proposed',
        data: {
          ...base.data,
          kind: 'receipt_confirm',
          payload: { receipt_id: receiptId },
          summary_vi: 'Nhập hóa đơn',
        },
      },
      scripted[scripted.length - 1],
    ]);
    const events = await reply(id);
    const proposed = events.find((e) => e.event === 'action.proposed');
    if (proposed?.event !== 'action.proposed') throw new Error('unreachable');
    return proposed.data;
  }
  const confirm = (actionId: string) =>
    api().raw.POST('/v1/assistant/actions/{actionId}/confirm', {
      params: { path: { actionId }, header: { 'Idempotency-Key': actionId } },
    });
  const draft = () =>
    createReceipt(
      registerImage({
        contentType: 'image/jpeg',
        byteSize: 100,
        purpose: 'expense_receipt',
      }).id,
    );

  test('confirming marks the mock receipt confirmed', async () => {
    const receipt = draft();
    const action = await proposeReceiptConfirm(receipt.id);
    expect((await confirm(action.id)).data!.status).toBe('done');
    expect(getReceipt(receipt.id).status).toBe('confirmed');
    expect(getReceipt(receipt.id).confirmed_at).not.toBeNull();
  });

  test('a receipt that is no longer a draft conflicts', async () => {
    const receipt = draft();
    const action = await proposeReceiptConfirm(receipt.id);
    receipt.status = 'discarded';
    const result = await confirm(action.id);
    expect(result.response.status).toBe(409);
    expect(result.error?.code).toBe('already_confirmed');
  });
});
