import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import { createThread, jsonError } from '../src/assistant-helpers.js';

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
