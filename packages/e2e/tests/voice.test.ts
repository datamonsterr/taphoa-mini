import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CreatedStore } from '../src/helpers.js';
import { createStore } from '../src/helpers.js';
import { getBackendUrl } from '../src/env.js';
import { percentile } from '../src/latency.js';
import { catalogProduct, uuid7 } from '../src/stock-fixtures.js';

/**
 * Voice sale drafts (epic V1) with the fixture clips in fixtures/voice/ (sidecars list the
 * products and customers a fresh store needs). Run against Railway `test` by the controller.
 * Clips missing from the checkout skip their case with a message instead of failing.
 */
const dir = new URL('../fixtures/voice/', import.meta.url);
const SAMPLES = Number(process.env.VOICE_LATENCY_SAMPLES ?? 20);
const BUDGET_MS = Number(process.env.VOICE_P95_MS ?? 3000);
// Set to the backend's VOICE_DAILY_UTTERANCES_PER_STORE when it is low enough to exhaust.
const QUOTA_CAP = Number(process.env.VOICE_E2E_DAILY_CAP ?? 0);

interface Sidecar {
  intent: 'sale' | 'chat' | 'none';
  payment_method?: string;
  customer?: string;
  lines?: {
    spoken: string;
    quantity: number;
    status: string;
    unit_price?: number;
  }[];
  requires_products?: string[];
  requires_customers?: string[];
  error?: string;
}

function clip(name: string): { audio: Buffer; sidecar: Sidecar } | undefined {
  const audio = new URL(`${name}.m4a`, dir);
  const sidecar = new URL(`${name}.json`, dir);
  if (!existsSync(audio) || !existsSync(sidecar)) {
    console.warn(`voice e2e: fixture clip ${name}.m4a is missing, skipping`);
    return undefined;
  }
  return {
    audio: readFileSync(audio),
    sidecar: JSON.parse(readFileSync(sidecar, 'utf8')) as Sidecar,
  };
}

async function prepare(sidecar: Sidecar): Promise<CreatedStore> {
  const store = await createStore();
  for (const name of sidecar.requires_products ?? []) {
    await catalogProduct(store.client, name);
  }
  for (const name of sidecar.requires_customers ?? []) {
    const created = await store.client.raw.POST('/v1/customers', {
      body: { id: uuid7(), name },
    });
    expect(created.response.status, JSON.stringify(created.error)).toBe(201);
  }
  return store;
}

async function utter(
  store: CreatedStore,
  audio: Buffer,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.set(
    'audio',
    new Blob([new Uint8Array(audio)], { type: 'audio/mp4' }),
    'clip.m4a',
  );
  form.set('mode', 'sale');
  form.set('language', 'vi');
  form.set('context', JSON.stringify({ entry: 'chat', screen: 'e2e' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const started = performance.now();
  const response = await fetch(`${getBackendUrl()}/v1/voice/utterances`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${store.session.access_token}`,
      'x-store-id': store.session.store.id,
    },
    body: form,
  });
  const elapsed = performance.now() - started;
  const body = (await response.json().catch(() => null)) as any;
  return { status: response.status, body, elapsed };
}

describe('voice utterances', () => {
  it('drafts a two-line cash sale', async () => {
    const f = clip('two-line-sale');
    if (!f) return;
    const store = await prepare(f.sidecar);
    const r = await utter(store, f.audio);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.intent).toBe('sale');
    expect(r.body.sale_draft.payment_method).toBe('cash');
    expect(r.body.sale_draft.lines).toHaveLength(2);
    expect(
      r.body.sale_draft.lines.map((l: any) => l.status),
      JSON.stringify(r.body),
    ).toEqual(['matched', 'matched']);
    expect(r.body.sale_draft.lines.map((l: any) => l.quantity)).toEqual([2, 1]);
    // Report the outcome: idempotent, last write wins.
    for (const outcome of ['edited', 'confirmed']) {
      const posted = await fetch(
        `${getBackendUrl()}/v1/voice/utterances/${r.body.id}/outcome`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${store.session.access_token}`,
            'x-store-id': store.session.store.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ outcome }),
        },
      );
      expect(posted.status).toBe(204);
    }
  });

  it('turns an unknown product into a manual line at the spoken price', async () => {
    const f = clip('unknown-product');
    if (!f) return;
    const store = await prepare(f.sidecar);
    const r = await utter(store, f.audio);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const line = r.body.sale_draft.lines[0];
    expect(line.status).toBe('unknown');
    expect(line.product).toBeUndefined();
    expect(line.unit_price).toBe(15000);
    expect(line.price_source).toBe('spoken');
  });

  it('matches the customer of a credit sale', async () => {
    const f = clip('credit-sale');
    if (!f) return;
    const store = await prepare(f.sidecar);
    const r = await utter(store, f.audio);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sale_draft.payment_method).toBe('credit');
    expect(r.body.sale_draft.customer.status).toBe('matched');
  });

  it('answers 422 no_speech for silence', async () => {
    const f = clip('no-speech');
    if (!f) return;
    const store = await createStore();
    const r = await utter(store, f.audio);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe('no_speech');
  });

  it('rejects unsupported audio with 400 unsupported_format', async () => {
    const store = await createStore();
    const r = await utter(store, Buffer.from('not audio at all, just text'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('unsupported_format');
  });

  it.skipIf(!QUOTA_CAP)(
    'answers 429 voice_quota once the daily cap is spent',
    async () => {
      const f = clip('no-speech');
      if (!f) return;
      const store = await createStore();
      let last = 0;
      let code = '';
      for (let i = 0; i <= QUOTA_CAP; i += 1) {
        const r = await utter(store, f.audio);
        last = r.status;
        code = r.body?.code;
      }
      expect(last).toBe(429);
      expect(code).toBe('voice_quota');
    },
  );

  it(`p95 < ${BUDGET_MS} ms over ${SAMPLES} runs of the two-line clip`, async () => {
    const f = clip('two-line-sale');
    if (!f) return;
    const store = await prepare(f.sidecar);
    const warm = await utter(store, f.audio);
    expect(warm.status, JSON.stringify(warm.body)).toBe(201);
    const rows: { run: number; ms: number; model: string; serverMs: number }[] =
      [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const r = await utter(store, f.audio);
      // Record every sample before asserting, so a failure still shows the numbers.
      rows.push({
        run: i + 1,
        ms: Math.round(r.elapsed),
        model: String(r.body?.model),
        serverMs: Number(r.body?.latency_ms),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const samples = rows.map((row) => row.ms);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.info(
      [
        `voice latency p50=${Math.round(p50)} ms p95=${Math.round(p95)} ms (budget ${BUDGET_MS} ms)`,
        'run  client_ms  server_latency_ms  model',
        ...rows.map(
          (row) =>
            `${String(row.run).padStart(3)}  ${String(row.ms).padStart(9)}  ${String(row.serverMs).padStart(17)}  ${row.model}`,
        ),
      ].join('\n'),
    );
    expect(p95).toBeLessThan(BUDGET_MS);
  }, 180_000);
});
