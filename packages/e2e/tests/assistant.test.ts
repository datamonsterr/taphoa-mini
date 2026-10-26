import { randomUUID } from 'node:crypto';
import type {
  ApiClient,
  AssistantStreamEvent,
  components,
} from '@taphoa/api-client';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from 'vitest';
import { assertErrorResponse, createStore } from '../src/helpers.js';
import { uuid7 } from '../src/stock-fixtures.js';

type Thread = components['schemas']['AssistantThread'];
const liveDisabled = process.env.E2E_ASSISTANT_LIVE === '0';
if (liveDisabled)
  console.warn('Assistant live tests skipped: E2E_ASSISTANT_LIVE=0');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fields(value: unknown, shape: Record<string, string>) {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  const object = value as Record<string, unknown>;
  expect(Object.keys(object).sort()).toEqual(Object.keys(shape).sort());
  for (const [key, type] of Object.entries(shape)) {
    if (type.endsWith('?') && object[key] === null) continue;
    const base = type.replace(/\?$/, '');
    if (base === 'uuid') expect(object[key]).toMatch(uuid);
    else if (base === 'date') {
      expect(object[key]).toBeTypeOf('string');
      expect(Number.isNaN(Date.parse(object[key] as string))).toBe(false);
    } else if (base === 'integer')
      expect(Number.isInteger(object[key])).toBe(true);
    else if (base === 'array') expect(Array.isArray(object[key])).toBe(true);
    else {
      expect(typeof object[key]).toBe(base);
      if (base === 'object') expect(object[key]).not.toBeNull();
    }
  }
}

function money(value: unknown) {
  if (value !== null) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

// Explicit runtime checks complement the generated AssistantStreamEvent union.
function assertFrame(frame: AssistantStreamEvent) {
  const { event, data } = frame;
  switch (event) {
    case 'message.created':
      fields(data, { message_id: 'uuid', thread_id: 'uuid' });
      break;
    case 'message.delta':
      fields(data, { text: 'string' });
      break;
    case 'tool.started':
      fields(data, { call_id: 'string', tool: 'string', label_vi: 'string' });
      break;
    case 'tool.finished':
      fields(data, {
        call_id: 'string',
        tool: 'string',
        ok: 'boolean',
        summary_vi: 'string',
      });
      break;
    case 'message.completed':
      fields(data, { message_id: 'uuid', model: 'string', usage: 'object' });
      fields(data.usage, { input_tokens: 'integer', output_tokens: 'integer' });
      expect(data.usage.input_tokens).toBeGreaterThanOrEqual(0);
      expect(data.usage.output_tokens).toBeGreaterThanOrEqual(0);
      break;
    case 'error':
      fields(data, { code: 'string', message_vi: 'string' });
      expect(['quota', 'model_unavailable', 'timeout', 'internal']).toContain(
        data.code,
      );
      break;
    case 'action.proposed':
      fields(data, {
        id: 'uuid',
        thread_id: 'uuid',
        message_id: 'uuid',
        kind: 'string',
        status: 'string',
        payload: 'object',
        summary_vi: 'string',
        proposed_by: 'uuid',
        decided_by: 'uuid?',
        decided_at: 'date?',
        result: 'object?',
        error: 'object?',
        expires_at: 'date',
        created_at: 'date',
      });
      expect([
        'stock_adjustment',
        'expense',
        'price_change',
        'threshold_update',
        'reorder_list',
        'receipt_line_update',
        'receipt_confirm',
        'repayment',
        'debt_adjustment',
        'invite',
      ]).toContain(data.kind);
      expect([
        'proposed',
        'executing',
        'done',
        'failed',
        'rejected',
        'expired',
      ]).toContain(data.status);
      if (data.error !== null)
        fields(data.error, { code: 'string', message: 'string' });
      break;
    case 'card':
      switch (data.type) {
        case 'chart_bars':
          fields(data, {
            type: 'string',
            title_vi: 'string',
            unit: 'string',
            bars: 'array',
          });
          expect(['dong', 'units']).toContain(data.unit);
          for (const bar of data.bars)
            fields(bar, { label: 'string', value: 'integer' });
          break;
        case 'restock_list':
          fields(data, {
            type: 'string',
            items: 'array',
            total_cost: 'number?',
          });
          money(data.total_cost);
          for (const item of data.items) {
            fields(item, {
              product_id: 'uuid',
              name: 'string',
              quantity: 'integer',
              unit_cost: 'number?',
              total_cost: 'number?',
            });
            expect(item.quantity).toBeGreaterThanOrEqual(1);
            money(item.unit_cost);
            money(item.total_cost);
          }
          break;
        case 'receipt_lines':
          fields(data, { type: 'string', receipt_id: 'uuid', lines: 'array' });
          for (const line of data.lines) {
            fields(line, {
              line_id: 'uuid',
              name: 'string',
              quantity: 'number?',
              cost: 'number?',
              product_id: 'uuid?',
              product_name: 'string?',
              confidence: 'number?',
            });
            if (line.quantity !== null)
              expect(line.quantity).toBeGreaterThan(0);
            if (line.confidence !== null) {
              expect(line.confidence).toBeGreaterThanOrEqual(0);
              expect(line.confidence).toBeLessThanOrEqual(1);
            }
            money(line.cost);
          }
          break;
        case 'debt_list':
          fields(data, { type: 'string', items: 'array' });
          for (const item of data.items) {
            fields(item, {
              customer_id: 'uuid',
              name: 'string',
              total: 'number',
              overdue_days: 'integer',
            });
            money(item.total);
            expect(item.overdue_days).toBeGreaterThanOrEqual(0);
          }
          break;
        default:
          expect.fail(`Unknown card: ${JSON.stringify(data)}`);
      }
      break;
    default:
      expect.fail(`Unknown frame: ${JSON.stringify(frame)}`);
  }
}

async function createThread(client: ApiClient): Promise<Thread> {
  const result = await client.raw.POST('/v1/assistant/threads', {
    body: { title: 'E2E assistant', context: { screen: 'camera' } },
  });
  expect(result.response.status, JSON.stringify(result.error)).toBe(201);
  expect(result.data!.id).toMatch(uuid);
  return result.data!;
}

function jsonError(response: Response, error: unknown, status: number) {
  expect(response.status, JSON.stringify(error)).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  assertErrorResponse(error);
}

describe('assistant deterministic contracts', () => {
  it('creates, paginates newest first, reads, isolates and deletes threads', async () => {
    const { client } = await createStore();
    const other = await createStore();
    const older = await createThread(client);
    const newer = await createThread(client);
    const first = await client.raw.GET('/v1/assistant/threads', {
      params: { query: { limit: 1 } },
    });
    expect(first.response.status).toBe(200);
    expect(first.data!.items.map((thread) => thread.id)).toEqual([newer.id]);
    expect(first.data!.next_cursor).toBeTypeOf('string');
    const second = await client.raw.GET('/v1/assistant/threads', {
      params: { query: { limit: 1, cursor: first.data!.next_cursor! } },
    });
    expect(second.response.status).toBe(200);
    expect(second.data!.items.map((thread) => thread.id)).toEqual([older.id]);
    expect(second.data!.next_cursor).toBeNull();
    const params = { path: { threadId: older.id } };
    const detail = await client.raw.GET('/v1/assistant/threads/{threadId}', {
      params,
    });
    expect(detail.response.status).toBe(200);
    expect(detail.data).toEqual({ thread: older, messages: [], actions: [] });
    const hidden = await other.client.raw.GET(
      '/v1/assistant/threads/{threadId}',
      { params },
    );
    jsonError(hidden.response, hidden.error, 404);
    const forbiddenDelete = await other.client.raw.DELETE(
      '/v1/assistant/threads/{threadId}',
      { params },
    );
    jsonError(forbiddenDelete.response, forbiddenDelete.error, 404);
    for (const threadId of [older.id, newer.id]) {
      const removed = await client.raw.DELETE(
        '/v1/assistant/threads/{threadId}',
        { params: { path: { threadId } } },
      );
      expect(removed.response.status).toBe(204);
      const absent = await client.raw.GET('/v1/assistant/threads/{threadId}', {
        params: { path: { threadId } },
      });
      jsonError(absent.response, absent.error, 404);
    }
  });

  it('ranks camera next steps and requires a screen', async () => {
    const { client } = await createStore();
    for (const document_detected of [false, true]) {
      const result = await client.raw.GET('/v1/assistant/next-steps', {
        params: { query: { screen: 'camera', document_detected } },
      });
      expect(result.response.status).toBe(200);
      const items = result.data!.items;
      expect(items.length).toBeLessThanOrEqual(8);
      const priorities = items.map((item) => item.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
      if (document_detected) expect(items[0].id).toBe('receipt_detected');
    }
    // Deliberately omit a required query parameter to exercise runtime validation.
    const missing = await client.raw.GET('/v1/assistant/next-steps', {
      // @ts-expect-error screen is required by OpenAPI
      params: { query: {} },
    });
    jsonError(missing.response, missing.error, 400);
  });

  it('returns JSON validation and ownership errors before streaming', async () => {
    const { client } = await createStore();
    const other = await createStore();
    const thread = await createThread(client);
    const empty = await client.sendAssistantMessage(thread.id, {
      content: '',
      language: 'vi',
    });
    jsonError(empty.response, empty.error, 400);
    expect(empty).not.toHaveProperty('events');
    const hidden = await other.client.sendAssistantMessage(thread.id, {
      content: 'Xin chào',
      language: 'vi',
    });
    jsonError(hidden.response, hidden.error, 404);
    expect(hidden).not.toHaveProperty('events');
    const feedback = await client.raw.POST(
      '/v1/assistant/messages/{messageId}/feedback',
      {
        params: { path: { messageId: randomUUID() } },
        body: { rating: 'up' },
      },
    );
    jsonError(feedback.response, feedback.error, 404);
    const actionId = randomUUID();
    const confirm = await client.raw.POST(
      '/v1/assistant/actions/{actionId}/confirm',
      {
        params: { path: { actionId }, header: { 'Idempotency-Key': actionId } },
      },
    );
    jsonError(confirm.response, confirm.error, 404);
    const reject = await client.raw.POST(
      '/v1/assistant/actions/{actionId}/reject',
      { params: { path: { actionId } } },
    );
    jsonError(reject.response, reject.error, 404);
    const noKey = await client.raw.POST(
      '/v1/assistant/actions/{actionId}/confirm',
      {
        // @ts-expect-error Idempotency-Key is deliberately missing
        params: { path: { actionId } },
      },
    );
    jsonError(noKey.response, noKey.error, 400);
  });
});

describe(
  'assistant live free-model contracts',
  { concurrent: false, retry: 0 },
  () => {
    let client: ApiClient;
    let thread: Thread;
    let liveMessages = 0;
    let quota = false;
    const timeout = 420_000; // Six model attempts at the default 60 s timeout, plus tools.

    beforeAll(async () => {
      if (liveDisabled) return;
      ({ client } = await createStore());
      thread = await createThread(client);
    });
    afterAll(() => expect(liveMessages).toBeLessThanOrEqual(4));

    async function send(ctx: TestContext, content: string) {
      if (liveDisabled || quota) ctx.skip();
      liveMessages += 1;
      expect(liveMessages).toBeLessThanOrEqual(4);
      const result = await client.sendAssistantMessage(
        thread.id,
        { content, language: 'vi' },
        { signal: AbortSignal.timeout(timeout - 5000) },
      );
      expect(result.response.status, JSON.stringify(result.error)).toBe(200);
      expect(result.response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(result.events).toBeDefined();
      const frames: AssistantStreamEvent[] = [];
      for await (const frame of result.events!) {
        assertFrame(frame);
        frames.push(frame);
      }
      expect(frames[0]?.event, JSON.stringify(frames)).toBe('message.created');
      const terminal = frames.at(-1)!;
      expect(['message.completed', 'error']).toContain(terminal.event);
      if (terminal.event === 'error' && terminal.data.code === 'quota') {
        quota = true;
        console.warn(
          'Assistant live tests skipped: shared daily quota exhausted',
        );
        ctx.skip();
      }
      expect(terminal.event, JSON.stringify(frames)).toBe('message.completed');
      if (terminal.event !== 'message.completed')
        throw new Error(JSON.stringify(frames));
      expect(terminal.data.model).toMatch(/.+:free$/);
      expect(frames[0]).toEqual({
        event: 'message.created',
        data: { message_id: terminal.data.message_id, thread_id: thread.id },
      });
      return { frames, messageId: terminal.data.message_id };
    }

    it(
      'streams a greeting and persists both messages',
      async (ctx) => {
        const content = 'Xin chào, bạn giúp được gì cho cửa hàng?';
        const { frames, messageId } = await send(ctx, content);
        const text = frames
          .flatMap((frame) =>
            frame.event === 'message.delta' ? [frame.data.text] : [],
          )
          .join('');
        expect(text.trim().length).toBeGreaterThan(0);
        const detail = await client.raw.GET(
          '/v1/assistant/threads/{threadId}',
          { params: { path: { threadId: thread.id } } },
        );
        expect(detail.response.status).toBe(200);
        expect(detail.data!.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'user', content }),
            expect.objectContaining({
              id: messageId,
              role: 'assistant',
              content: text,
            }),
          ]),
        );
      },
      timeout,
    );

    it(
      'uses a read tool for sales on a store with a completed sale',
      async (ctx) => {
        if (liveDisabled || quota) ctx.skip();
        const id = uuid7();
        const sale = await client.raw.POST('/v1/sales', {
          headers: { 'Idempotency-Key': id },
          body: {
            id,
            sold_at: new Date().toISOString(),
            payment_method: 'cash',
            cash_received: 7000,
            total: 7000,
            lines: [
              {
                id: uuid7(),
                product_id: null,
                source: 'manual',
                quantity: 1,
                unit_price: 7000,
                manual_label: 'E2E item',
              },
            ],
          },
        });
        expect(sale.response.status, JSON.stringify(sale.error)).toBe(201);
        const { frames } = await send(
          ctx,
          'Hôm nay cửa hàng bán được bao nhiêu tiền?',
        );
        const paired = frames.some(
          (frame, index) =>
            frame.event === 'tool.started' &&
            !frame.data.tool.startsWith('propose_') &&
            frames
              .slice(index + 1)
              .some(
                (finish) =>
                  finish.event === 'tool.finished' &&
                  finish.data.call_id === frame.data.call_id &&
                  finish.data.tool === frame.data.tool &&
                  finish.data.ok,
              ),
        );
        expect(paired, JSON.stringify(frames)).toBe(true);
      },
      timeout,
    );

    it(
      'proposes an expense, confirms exactly once and accepts feedback',
      async (ctx) => {
        if (liveDisabled || quota) ctx.skip();
        async function expenses() {
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Ho_Chi_Minh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date());
          const result = await client.raw.GET('/v1/expenses', {
            params: { query: { from: today, to: today } },
          });
          expect(result.response.status).toBe(200);
          return result.data!.items;
        }
        expect(await expenses()).toEqual([]);
        const content =
          'Hãy đề xuất ghi một khoản chi phí tiền điện 150000 đồng, trả bằng tiền mặt.';
        let reply = await send(ctx, content);
        const attempts = [...reply.frames];
        let proposal = reply.frames.find(
          (frame) =>
            frame.event === 'action.proposed' && frame.data.kind === 'expense',
        );
        if (!proposal) {
          reply = await send(ctx, content);
          attempts.push(...reply.frames);
          proposal = reply.frames.find(
            (frame) =>
              frame.event === 'action.proposed' &&
              frame.data.kind === 'expense',
          );
        }
        expect(proposal, JSON.stringify(attempts)).toBeDefined();
        if (!proposal || proposal.event !== 'action.proposed')
          throw new Error(JSON.stringify(attempts));
        expect(proposal.data.status).toBe('proposed');
        expect(proposal.data.thread_id).toBe(thread.id);
        expect(proposal.data.message_id).toBe(reply.messageId);
        expect(await expenses()).toEqual([]);
        const actionId = proposal.data.id;
        const params = {
          path: { actionId },
          header: { 'Idempotency-Key': actionId },
        };
        const confirmed = await client.raw.POST(
          '/v1/assistant/actions/{actionId}/confirm',
          { params },
        );
        expect(confirmed.response.status, JSON.stringify(confirmed.error)).toBe(
          200,
        );
        expect(confirmed.data!.status).toBe('done');
        const expenseId = confirmed.data!.result?.expense_id;
        expect(expenseId).toMatch(uuid);
        const recorded = await expenses();
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toEqual(
          expect.objectContaining({
            id: expenseId,
            amount: 150000,
            paid_with: 'cash_box',
          }),
        );
        const proposedCategory = (
          proposal.data.payload as { category?: string } | undefined
        )?.category;
        if (proposedCategory === 'dien')
          expect(recorded[0]).toEqual(
            expect.objectContaining({ category: 'dien' }),
          );
        const replay = await client.raw.POST(
          '/v1/assistant/actions/{actionId}/confirm',
          { params },
        );
        expect(replay.response.status).toBe(200);
        expect(replay.data).toEqual(confirmed.data);
        expect(await expenses()).toEqual(recorded);
        const rejected = await client.raw.POST(
          '/v1/assistant/actions/{actionId}/reject',
          { params: { path: { actionId } } },
        );
        jsonError(rejected.response, rejected.error, 409);
        assertErrorResponse(rejected.error, 'already_decided');
        const feedback = await client.raw.POST(
          '/v1/assistant/messages/{messageId}/feedback',
          {
            params: { path: { messageId: reply.messageId } },
            body: { rating: 'up' },
          },
        );
        expect(feedback.response.status).toBe(204);
      },
      timeout * 2,
    );
  },
);
