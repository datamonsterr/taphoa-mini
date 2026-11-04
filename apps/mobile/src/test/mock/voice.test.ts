import { createApiClient } from '@taphoa/api-client';
import {
  createMockFetch,
  getMockDb,
  getVoiceOutcome,
  PRODUCT_IDS,
  resetMockDb,
  setVoiceQuotaExceeded,
} from './index';

const api = () =>
  createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch() });
const context = { entry: 'longpress' as const, screen: 'camera' };

function utter(
  name: string,
  extra: { mode?: 'sale' | 'transcribe'; type?: string; size?: number } = {},
) {
  const bytes = new Uint8Array(extra.size ?? 8);
  return api().createVoiceUtterance({
    audio: new Blob([bytes], { type: extra.type ?? 'audio/mp4' }),
    filename: name,
    mode: extra.mode ?? 'sale',
    context,
  });
}

beforeEach(resetMockDb);

test('two-line-sale resolves two seeded products with catalog prices', async () => {
  const { data, response } = await utter('two-line-sale.m4a');
  expect(response.status).toBe(201);
  expect(data).toMatchObject({ mode: 'sale', intent: 'sale', language: 'vi' });
  const draft = data!.sale_draft!;
  expect(draft.payment_method).toBe('cash');
  expect(draft.lines.map((l) => l.product?.id)).toEqual([
    PRODUCT_IDS.coca,
    PRODUCT_IDS.pepsi,
  ]);
  expect(draft.lines.map((l) => l.quantity)).toEqual([2, 1]);
  expect(draft.lines.every((l) => l.status === 'matched')).toBe(true);
  const seeded = (id: string) =>
    getMockDb().products.find((r) => r.product.id === id)!.product.price;
  expect(draft.total).toBe(
    2 * seeded(PRODUCT_IDS.coca) + seeded(PRODUCT_IDS.pepsi),
  );
});

test('unknown-product yields one unknown line with the spoken price', async () => {
  const { data } = await utter('unknown-product.m4a');
  const [line, ...rest] = data!.sale_draft!.lines;
  expect(rest).toEqual([]);
  expect(line).toMatchObject({
    status: 'unknown',
    unit_price: 35000,
    price_source: 'spoken',
  });
  expect(line!.product).toBeUndefined();
  expect(data!.sale_draft!.total).toBe(35000);
});

test('credit-sale matches a customer that exists in the mock DB', async () => {
  const { data } = await utter('credit-sale.m4a');
  const draft = data!.sale_draft!;
  expect(draft.payment_method).toBe('credit');
  expect(draft.customer?.status).toBe('matched');
  const id = draft.customer!.customer!.id;
  expect(getMockDb().customers.some((c) => c.id === id)).toBe(true);
  await utter('credit-sale.m4a');
  expect(getMockDb().customers).toHaveLength(1);
});

test('ambiguous gives three seeded candidates', async () => {
  const { data } = await utter('ambiguous.m4a');
  const line = data!.sale_draft!.lines[0]!;
  expect(line.status).toBe('ambiguous');
  expect(line.candidates).toHaveLength(3);
  expect(line.candidates!.map((c) => c.id)).toContain(line.product!.id);
});

test('no-speech returns 422 no_speech', async () => {
  const { error, response } = await utter('no-speech.m4a');
  expect(response.status).toBe(422);
  expect((error as { code?: string }).code).toBe('no_speech');
});

test('chat-intent has intent chat and no draft', async () => {
  const { data } = await utter('chat-intent.m4a');
  expect(data!.intent).toBe('chat');
  expect(data!.sale_draft).toBeUndefined();
});

test('transcribe mode returns the transcript only', async () => {
  const { data } = await utter('two-line-sale.m4a', { mode: 'transcribe' });
  expect(data).toMatchObject({ mode: 'transcribe', intent: 'none' });
  expect(data!.transcript).not.toBe('');
  expect(data!.sale_draft).toBeUndefined();
});

test('voiceQuotaExceeded returns 429 voice_quota', async () => {
  setVoiceQuotaExceeded(true);
  const { error, response } = await utter('two-line-sale.m4a');
  expect(response.status).toBe(429);
  expect((error as { code?: string }).code).toBe('voice_quota');
  resetMockDb();
  expect((await utter('two-line-sale.m4a')).response.status).toBe(201);
});

test('rejects an unsupported format and an oversized upload', async () => {
  const bad = await utter('x.m4a', { type: 'audio/mpeg' });
  expect(bad.response.status).toBe(400);
  expect((bad.error as { code?: string }).code).toBe('unsupported_format');
  const big = await utter('x.m4a', { size: 1024 * 1024 + 1 });
  expect(big.response.status).toBe(413);
});

test('outcome is stored per utterance, last write wins, 404 when unknown', async () => {
  const { data } = await utter('two-line-sale.m4a');
  const id = data!.id;
  const first = await api().postVoiceOutcome(id, {
    outcome: 'abandoned',
    stage: 'draft',
  });
  expect(first.response.status).toBe(204);
  expect(getVoiceOutcome(id)).toMatchObject({ outcome: 'abandoned' });
  const body = {
    outcome: 'edited' as const,
    sale_id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
    corrections: [{ line_id: data!.sale_draft!.lines[0]!.id, quantity: 3 }],
  };
  await api().postVoiceOutcome(id, body);
  await api().postVoiceOutcome(id, body);
  expect(getVoiceOutcome(id)).toEqual(body);
  const missing = await api().postVoiceOutcome(
    '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3c',
    { outcome: 'confirmed' },
  );
  expect(missing.response.status).toBe(404);
  const invalid = await api().postVoiceOutcome(id, {
    outcome: 'nope',
  } as never);
  expect(invalid.response.status).toBe(400);
});
