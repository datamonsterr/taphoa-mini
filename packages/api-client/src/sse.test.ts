import { describe, expect, it, vi } from 'vitest';
import {
  parseSseStream,
  readAssistantStream,
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
} from './sse';
import { createApiClient, type AssistantStreamEvent } from './index';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}

describe('parseSseStream', () => {
  it('decodes mid-line and mid-UTF-8 chunks, CRLF, CR, comments and multiline data', async () => {
    const body = stream(
      '\uFEFF: heartbeat\r\nevent: delta\r\nid: 42\r\ndata: Tiếng Việt\r\ndata:  dòng hai\r\n\r\ndata: kế tiếp\r\rdata: dropped\n',
    );
    expect(await collect(parseSseStream(body))).toEqual([
      { event: 'delta', data: 'Tiếng Việt\n dòng hai', id: '42' },
      { event: 'message', data: 'kế tiếp', id: '42' },
    ]);
    expect(body.locked).toBe(false);
  });
});

it('cancels and unlocks when the consumer stops early', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n'));
    },
    cancel,
  });
  for await (const frame of parseSseStream(body)) {
    expect(frame.data).toBe('first');
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it('aborts a pending read and releases its lock', async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const next = parseSseStream(body, { signal: controller.signal }).next();
  controller.abort();
  await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it('rejects with AbortError when the signal lacks throwIfAborted', async () => {
  // React Native's AbortSignal polyfill may not implement throwIfAborted.
  const signal = {
    aborted: true,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const rejection = await parseSseStream(body, { signal })
    .next()
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).not.toBeInstanceOf(TypeError);
  expect(rejection).toMatchObject({ name: 'AbortError' });
  expect(body.locked).toBe(false);
});

const completed: AssistantStreamEvent = {
  event: 'message.completed',
  data: {
    message_id: 'm',
    model: 'mock/assistant',
    usage: { input_tokens: 2, output_tokens: 3 },
  },
};
const wire = (events: { event: string; data: unknown }[]) =>
  events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');

it('reads deltas, tools, proposals and cards while skipping unknown events', async () => {
  const events: AssistantStreamEvent[] = [
    { event: 'message.delta', data: { text: 'Tiếng Việt' } },
    {
      event: 'tool.started',
      data: { call_id: 'c', tool: 'get_sales_summary', label_vi: 'Đang xem…' },
    },
    {
      event: 'tool.finished',
      data: {
        call_id: 'c',
        tool: 'get_sales_summary',
        ok: true,
        summary_vi: 'Xong',
      },
    },
    {
      event: 'action.proposed',
      data: {
        id: 'a',
        thread_id: 't',
        message_id: 'm',
        kind: 'stock_adjustment',
        status: 'proposed',
        payload: { delta: 2 },
        summary_vi: 'Nhập hàng',
        proposed_by: 'u',
        decided_by: null,
        decided_at: null,
        result: null,
        error: null,
        expires_at: '2026-10-26T00:00:00Z',
        created_at: '2026-10-25T00:00:00Z',
      },
    },
    { event: 'card', data: { type: 'restock_list', items: [], total_cost: 0 } },
    completed,
  ];
  expect(
    await collect(
      readAssistantStream(
        stream('event: future\ndata: not-json\n\n' + wire(events)),
      ),
    ),
  ).toEqual(events);
});

it.each(['error', 'message.completed'] as const)(
  '%s is terminal and cancels before yielding trailing frames',
  async (name) => {
    const terminal: AssistantStreamEvent =
      name === 'error'
        ? { event: 'error', data: { code: 'quota', message_vi: 'Hết lượt' } }
        : completed;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            wire([
              terminal,
              { event: 'message.delta', data: { text: 'late' } },
            ]),
          ),
        );
      },
      cancel,
    });
    const events = readAssistantStream(body);
    expect(await events.next()).toEqual({ value: terminal, done: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await events.next()).toEqual({ value: undefined, done: true });
    expect(body.locked).toBe(false);
  },
);

it('throws interrupted on early end and protocol error on malformed JSON', async () => {
  await expect(
    collect(
      readAssistantStream(
        stream(wire([{ event: 'message.delta', data: { text: 'partial' } }])),
      ),
    ),
  ).rejects.toBeInstanceOf(AssistantStreamInterruptedError);
  await expect(
    collect(
      readAssistantStream(stream('event: message.delta\ndata: {oops\n\n')),
    ),
  ).rejects.toBeInstanceOf(AssistantStreamProtocolError);
});

it('keeps the no-arg interrupted error without a cause', () => {
  const error = new AssistantStreamInterruptedError();
  expect(error.name).toBe('AssistantStreamInterruptedError');
  expect(error.cause).toBeUndefined();
  expect('cause' in error).toBe(false);
});

it('surfaces a transport error mid-stream as interrupted with the original cause', async () => {
  const failure = new TypeError('Network request failed');
  const delta: AssistantStreamEvent = {
    event: 'message.delta',
    data: { text: 'partial' },
  };
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0)
        controller.enqueue(new TextEncoder().encode(wire([delta])));
      else controller.error(failure);
    },
  });
  const events = readAssistantStream(body);
  expect(await events.next()).toEqual({ value: delta, done: false });
  const error = await events.next().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AssistantStreamInterruptedError);
  expect((error as AssistantStreamInterruptedError).cause).toBe(failure);
  expect(body.locked).toBe(false);
});

it('rethrows the abort reason instead of reporting an interruption', async () => {
  const reason = new Error('user cancelled');
  const controller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const next = readAssistantStream(body, { signal: controller.signal }).next();
  controller.abort(reason);
  await expect(next).rejects.toBe(reason);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it('still yields message.completed when cancelling the body rejects', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(wire([completed])));
    },
    cancel() {
      throw new Error('cancel failed');
    },
  });
  expect(await collect(readAssistantStream(body))).toEqual([completed]);
  expect(body.locked).toBe(false);
});

it('sends one authenticated POST with Accept and never reconnects after a drop', async () => {
  const fetchMock = vi.fn(
    async (_request: Request) =>
      new Response(
        stream(wire([{ event: 'message.delta', data: { text: 'partial' } }])),
      ),
  );
  const api = createApiClient({
    baseUrl: 'https://mock.local/',
    fetch: fetchMock as typeof fetch,
    getToken: () => 'tok',
  });
  const result = await api.sendAssistantMessage('thread', {
    content: 'Chào',
    language: 'vi',
  });
  if (!result.events) throw new Error('Expected stream');
  await expect(collect(result.events)).rejects.toBeInstanceOf(
    AssistantStreamInterruptedError,
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  const req = fetchMock.mock.calls[0]![0];
  expect(req.method).toBe('POST');
  expect(req.url).toBe(
    'https://mock.local/v1/assistant/threads/thread/messages',
  );
  expect(req.headers.get('Authorization')).toBe('Bearer tok');
  expect(req.headers.get('Accept')).toBe('text/event-stream');
  expect(await req.json()).toEqual({ content: 'Chào', language: 'vi' });
});

it('returns a JSON 404 without attempting to parse it as SSE', async () => {
  const error = { error: 'Thread not found', code: 'not_found' };
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(error), { status: 404 }),
  );
  const api = createApiClient({
    baseUrl: 'https://mock.local',
    fetch: fetchMock as typeof fetch,
  });
  const result = await api.sendAssistantMessage('missing', {
    content: 'Chào',
    language: 'vi',
  });
  expect(result.error).toEqual(error);
  expect(result.response.status).toBe(404);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('reports an empty 2xx body as interrupted without using ReadableStream', async () => {
  // Build the response first: React Native has no global ReadableStream.
  const response = new Response(null, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'ReadableStream',
  );
  // Node's Request constructor needs the global, so hide it only once the
  // request is built, i.e. for the client code that handles the response.
  const fetchMock = vi.fn(async () => {
    Object.defineProperty(globalThis, 'ReadableStream', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    return response;
  });
  const api = createApiClient({
    baseUrl: 'https://mock.local',
    fetch: fetchMock as typeof fetch,
  });
  try {
    const result = await api.sendAssistantMessage('thread', {
      content: 'Chào',
      language: 'vi',
    });
    if (!result.events) throw new Error('Expected stream');
    expect(globalThis.ReadableStream).toBeUndefined();
    expect(result.response.status).toBe(200);
    await expect(result.events.next()).rejects.toBeInstanceOf(
      AssistantStreamInterruptedError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    if (original) Object.defineProperty(globalThis, 'ReadableStream', original);
    else delete (globalThis as { ReadableStream?: unknown }).ReadableStream;
  }
});
