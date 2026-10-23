import { describe, expect, it } from 'vitest';
import { getBackendUrl } from '../src/env.js';
import { createStore, joinAsSeller } from '../src/helpers.js';

interface SseFrame {
  id: string;
  event: string;
  data: Record<string, any>;
}

/** Minimal SSE reader over fetch; returns the next non-comment frame. */
async function openStream(token: string, lastEventId?: string) {
  const abort = new AbortController();
  const response = await fetch(`${getBackendUrl()}/v1/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(timeoutMs = 8000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = raw.split('\n').filter((l) => !l.startsWith(':'));
        if (lines.length === 0) continue; // heartbeat
        const field = (name: string) =>
          lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        return {
          id: field('id')!,
          event: field('event')!,
          data: JSON.parse(field('data')!),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for SSE frame');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('timed out reading SSE')),
            remaining,
          ),
        ),
      ]);
      if (chunk.done) throw new Error('SSE stream closed');
      buffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r\n/g, '\n');
    }
  }
  return { next, close: () => abort.abort() };
}

describe('Sync and events (E6)', () => {
  it('GET /v1/sync/changes returns the store snapshot, then only newer changes', async () => {
    const { client, session } = await createStore();
    const snapshot = await client.raw.GET('/v1/sync/changes');
    expect(snapshot.response.status).toBe(200);
    const entities = snapshot.data!.changes.map((c) => c.entity).sort();
    expect(entities).toEqual(['member', 'store']);
    expect(snapshot.data!.has_more).toBe(false);

    const empty = await client.raw.GET('/v1/sync/changes', {
      params: { query: { since: snapshot.data!.cursor } },
    });
    expect(empty.data!.changes).toEqual([]);
    expect(empty.data!.cursor).toBe(snapshot.data!.cursor);

    const bad = await client.raw.GET('/v1/sync/changes', {
      params: { query: { since: '%%%' } },
    });
    expect(bad.response.status).toBe(400);
    expect(session.store.id).toBeTruthy();
  });

  it('a store PATCH shows up in the change feed and as an SSE event with the same cursor', async () => {
    const { client, session } = await createStore();
    const start = await client.raw.GET('/v1/sync/changes');
    const stream = await openStream(session.access_token);
    try {
      const patch = await client.raw.PATCH('/v1/store', {
        headers: { 'content-type': 'application/merge-patch+json' },
        body: { name: 'Doi ten E6' },
      });
      expect(patch.response.status).toBe(200);

      const frame = await stream.next();
      expect(frame.event).toBe('store.changed');
      expect(frame.id).toMatch(/^evt_\d{15}$/);
      expect(frame.data.id).toBe(frame.id);
      expect(frame.data.store_id).toBe(session.store.id);
      expect(frame.data.data.fields).toContain('name');

      const delta = await client.raw.GET('/v1/sync/changes', {
        params: { query: { since: start.data!.cursor } },
      });
      expect(delta.data!.changes).toHaveLength(1);
      const change = delta.data!.changes[0]!;
      expect(change).toMatchObject({ entity: 'store', op: 'upsert' });
      expect((change.data as { name: string }).name).toBe('Doi ten E6');
      expect(delta.data!.cursor).toBe(frame.data.cursor);
    } finally {
      stream.close();
    }
  });

  it('a seller joining raises member.changed for the Lead and resumes with Last-Event-ID', async () => {
    const { client, session } = await createStore();
    const stream = await openStream(session.access_token);
    let lastId: string;
    try {
      await joinAsSeller(client);
      const frame = await stream.next();
      expect(frame.event).toBe('member.changed');
      expect(frame.data.data.change).toBe('joined');
      lastId = frame.id;
    } finally {
      stream.close();
    }

    // Offline gap: change the store while no stream is open.
    await client.raw.PATCH('/v1/store', {
      headers: { 'content-type': 'application/merge-patch+json' },
      body: { margin_threshold_pct: 7 },
    });
    const resumed = await openStream(session.access_token, lastId);
    try {
      const frame = await resumed.next();
      expect(frame.event).toBe('store.changed');
      expect(frame.id > lastId).toBe(true);
    } finally {
      resumed.close();
    }
  });

  it('GET /v1/events requires a bearer token', async () => {
    const response = await fetch(`${getBackendUrl()}/v1/events`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});
