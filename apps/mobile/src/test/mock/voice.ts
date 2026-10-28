import type {
  CustomerMatch,
  VoiceDraftLine,
  VoiceOutcomeRequest,
  VoiceSaleDraft,
  VoiceUtterance,
  components,
} from '@taphoa/api-client';
import { newUuid } from '@/lib/uuid';
import { createCustomer } from './debts';
import { getMockDb, nowIso } from './db';
import {
  badRequest,
  MockHttpError,
  notFound,
  unprocessableEntity,
} from './errors';
import { PRODUCT_IDS } from './fixtures';
import { seedUuid } from './ids';
import { readMultipart } from './multipart';
import type { MockRoute, RouteResult } from './routes';
import { asObject, isUuid } from './validate';

type ProductSummary = components['schemas']['ProductSummary'];
type PaymentMethod = components['schemas']['PaymentMethod'];

const MAX_BYTES = 1024 * 1024;
const AUDIO_TYPES = ['audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/ogg'];
const OUTCOMES = ['confirmed', 'edited', 'abandoned'];
const STAGES = ['listening', 'draft', 'pay'];

/** Fixed customer the credit-sale clip resolves to; created on first use. */
export const VOICE_CUSTOMER_ID = seedUuid(2001);

export function setVoiceQuotaExceeded(value: boolean) {
  getMockDb().voice.voiceQuotaExceeded = value;
}
export function getVoiceOutcome(utteranceId: string) {
  return getMockDb().voice.outcomes.get(utteranceId);
}

function summary(key: keyof typeof PRODUCT_IDS): ProductSummary {
  const record = getMockDb().products.find(
    (r) => r.product.id === PRODUCT_IDS[key],
  );
  if (!record) throw notFound(`Seed product ${key}`);
  const { product } = record;
  return {
    id: product.id,
    name: product.name ?? null,
    price: product.price,
    base_unit: product.base_unit,
    units: product.units,
    image_url: product.images[0]?.url ?? null,
  };
}

function matched(
  key: keyof typeof PRODUCT_IDS,
  spoken: string,
  quantity: number,
): VoiceDraftLine {
  const product = summary(key);
  return {
    id: newUuid(),
    spoken,
    status: 'matched',
    product,
    unit_id: null,
    quantity,
    unit_price: product.price,
    price_source: 'catalog',
    price_mismatch: false,
    needs_price: false,
  };
}

const totalOf = (lines: VoiceDraftLine[]) =>
  lines.reduce((sum, l) => sum + (l.unit_price ?? 0) * l.quantity, 0);

function draft(
  lines: VoiceDraftLine[],
  payment_method: PaymentMethod = 'cash',
  customer?: CustomerMatch,
): VoiceSaleDraft {
  return {
    lines,
    payment_method,
    ...(customer ? { customer } : {}),
    total: totalOf(lines),
  };
}

type Canned = {
  transcript: string;
  intent: VoiceUtterance['intent'];
  build?: () => VoiceSaleDraft;
};

const CANNED: Record<string, Canned> = {
  'two-line-sale.m4a': {
    transcript: 'hai lon coca với một lon pepsi',
    intent: 'sale',
    build: () =>
      draft([matched('coca', 'coca', 2), matched('pepsi', 'pepsi', 1)]),
  },
  'unknown-product.m4a': {
    transcript: 'một bao gạo ST25 giá ba mươi lăm nghìn',
    intent: 'sale',
    build: () =>
      draft([
        {
          id: newUuid(),
          spoken: 'gạo ST25',
          status: 'unknown',
          unit_id: null,
          quantity: 1,
          unit_price: 35000,
          price_source: 'spoken',
          price_mismatch: false,
          needs_price: false,
        },
      ]),
  },
  'credit-sale.m4a': {
    transcript: 'hai lon coca ghi nợ chị Lan',
    intent: 'sale',
    build: () => {
      const { customer } = createCustomer({
        id: VOICE_CUSTOMER_ID,
        name: 'Chị Lan',
      });
      return draft([matched('coca', 'coca', 2)], 'credit', {
        status: 'matched',
        customer,
        spoken_name: 'chị Lan',
      });
    },
  },
  'ambiguous.m4a': {
    transcript: 'ba lon nước ngọt',
    intent: 'sale',
    build: () => {
      const candidates = [summary('coca'), summary('pepsi'), summary('7up')];
      const first = candidates[0]!;
      return draft([
        {
          id: newUuid(),
          spoken: 'nước ngọt',
          status: 'ambiguous',
          product: first,
          candidates,
          unit_id: null,
          quantity: 3,
          unit_price: first.price,
          price_source: 'catalog',
          price_mismatch: false,
          needs_price: false,
        },
      ]);
    },
  },
  'chat-intent.m4a': {
    transcript: 'hôm nay bán được bao nhiêu',
    intent: 'chat',
  },
};

function context(value: unknown) {
  if (value === undefined) return;
  try {
    const parsed = asObject(JSON.parse(String(value)));
    if (typeof parsed.entry !== 'string' || typeof parsed.screen !== 'string')
      throw new Error('shape');
  } catch {
    throw badRequest('context must be JSON with entry and screen', {
      field: 'context',
    });
  }
}

async function createUtterance({
  request,
}: {
  request: Request;
}): Promise<RouteResult> {
  const db = getMockDb();
  const fields = await readMultipart(request);
  const mode = fields.get('mode');
  if (mode !== 'sale' && mode !== 'transcribe')
    throw badRequest('mode must be sale or transcribe', { field: 'mode' });
  const language = fields.get('language') ?? 'vi';
  if (language !== 'vi' && language !== 'en')
    throw badRequest('language must be vi or en', { field: 'language' });
  context(fields.get('context'));
  const audio = fields.get('audio');
  if (audio === undefined || typeof audio === 'string')
    throw badRequest('audio must be a file part', { field: 'audio' });
  if (audio.type && !AUDIO_TYPES.includes(audio.type))
    throw badRequest(
      'Unsupported audio format',
      { field: 'audio' },
      'unsupported_format',
    );
  if ((audio.size ?? 0) > MAX_BYTES)
    throw new MockHttpError(413, 'payload_too_large', 'Audio above 1 MB');
  if (db.voice.voiceQuotaExceeded)
    throw new MockHttpError(429, 'voice_quota', 'Daily voice limit reached');

  const name = audio.name?.split('/').pop() ?? '';
  if (name === 'no-speech.m4a')
    throw unprocessableEntity('Nothing heard', undefined, 'no_speech');
  const canned = CANNED[name] ?? CANNED['two-line-sale.m4a']!;
  const sale = mode === 'sale' && canned.intent === 'sale';
  const utterance: VoiceUtterance = {
    id: newUuid(),
    mode,
    transcript: canned.transcript,
    language,
    intent: mode === 'transcribe' ? 'none' : canned.intent,
    confidence: 0.92,
    ...(sale && canned.build ? { sale_draft: canned.build() } : {}),
    model: 'mock/voice',
    stt_fallback: false,
    latency_ms: 800,
    created_at: nowIso(),
  };
  db.voice.utterances.set(utterance.id, utterance);
  return { status: 201, body: utterance };
}

async function postOutcome({
  params,
  request,
}: {
  params: Record<string, string>;
  request: Request;
}): Promise<RouteResult> {
  const id = params.utteranceId!;
  if (!isUuid(id)) throw badRequest('Invalid utteranceId');
  const db = getMockDb();
  if (!db.voice.utterances.has(id)) throw notFound('Utterance');
  let raw: Record<string, unknown>;
  try {
    raw = asObject(JSON.parse((await request.text()) || '{}'));
  } catch (error) {
    if (error instanceof MockHttpError) throw error;
    throw badRequest('body is not valid JSON');
  }
  if (typeof raw.outcome !== 'string' || !OUTCOMES.includes(raw.outcome))
    throw badRequest('Invalid outcome', { field: 'outcome' });
  if (raw.stage !== undefined && !STAGES.includes(String(raw.stage)))
    throw badRequest('Invalid stage', { field: 'stage' });
  if (raw.sale_id !== undefined && !isUuid(raw.sale_id))
    throw badRequest('Invalid sale_id', { field: 'sale_id' });
  if (raw.corrections !== undefined && !Array.isArray(raw.corrections))
    throw badRequest('corrections must be an array', { field: 'corrections' });
  db.voice.outcomes.set(id, raw as unknown as VoiceOutcomeRequest);
  return { status: 204 };
}

export const VOICE_ROUTES: MockRoute[] = [
  { method: 'POST', path: '/v1/voice/utterances', handler: createUtterance },
  {
    method: 'POST',
    path: '/v1/voice/utterances/{utteranceId}/outcome',
    handler: postOutcome,
  },
];
