import type { VoiceUtterance } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { actualIntent, aggregate, matchLines, scoreCase } from './score.ts';
import type { ExpectedLine, VoiceCase, VoiceOutcome } from './types.ts';

type Draft = NonNullable<VoiceUtterance['sale_draft']>;
type Line = Draft['lines'][number];

const line = (over: Partial<Line> & { name?: string | null } = {}): Line => {
  const { name, ...rest } = over;
  return {
    id: '00000000-0000-4000-8000-000000000001',
    spoken: 'coca',
    status: 'matched',
    product:
      name === null
        ? undefined
        : {
            id: '00000000-0000-4000-8000-0000000000aa',
            name: name ?? 'Coca-Cola lon 320ml',
            price: 11000,
            base_unit: 'lon',
          },
    quantity: 2,
    unit_price: 11000,
    price_source: 'catalog',
    ...rest,
  } as Line;
};

const utterance = (over: Partial<VoiceUtterance> = {}): VoiceUtterance => ({
  id: '00000000-0000-4000-8000-0000000000bb',
  mode: 'sale',
  transcript: 'hai lon coca',
  language: 'vi',
  intent: 'sale',
  model: 'google/gemini-2.5-flash-lite',
  latency_ms: 1200,
  created_at: '2026-10-28T00:00:00Z',
  ...over,
});

const outcome = (
  u: VoiceUtterance | null,
  lines: Line[] = [],
  payment: 'cash' | 'transfer' | 'credit' = 'cash',
  extra: Partial<VoiceOutcome> = {},
): VoiceOutcome => ({
  case_id: 'v01',
  status: u ? 201 : 422,
  wall_ms: 1500,
  ...(u
    ? {
        utterance: {
          ...u,
          sale_draft: lines.length
            ? ({ lines, payment_method: payment, total: 0 } as Draft)
            : undefined,
        },
      }
    : {}),
  ...extra,
});

const exp = (over: Partial<ExpectedLine> = {}): ExpectedLine => ({
  spoken: 'coca',
  product: 'Coca-Cola lon 320ml',
  quantity: 2,
  unit_price: null,
  ...over,
});

const mkCase = (over: Partial<VoiceCase> = {}): VoiceCase => ({
  id: 'v01',
  source: 'synthetic',
  transcript: 'hai lon coca',
  language: 'vi',
  intent: 'sale',
  payment_method: 'cash',
  lines: [exp()],
  tags: [],
  ...over,
});

describe('scoreCase', () => {
  it('scores a perfect single line', () => {
    const s = scoreCase(mkCase(), outcome(utterance(), [line()]));
    expect(s).toMatchObject({
      intent_ok: true,
      lines_ok: 1,
      quantity_ok: 1,
      price_ok: 1,
      exact: true,
      payment_ok: true,
      error: null,
    });
    expect(s.wer).toEqual({ edits: 0, words: 3 });
  });

  it('matches by normalized name, ignoring case and order', () => {
    const c = mkCase({
      lines: [
        exp({ product: 'Pepsi lon 320ml', spoken: 'pepsi', quantity: 1 }),
        exp(),
      ],
    });
    const s = scoreCase(
      c,
      outcome(utterance(), [
        line(),
        line({ name: 'PEPSI lon 320ml', quantity: 1, spoken: 'pepsi' }),
      ]),
    );
    expect(s.lines_ok).toBe(2);
  });

  it('matches by product id when the sidecar carries one', () => {
    const c = mkCase({
      lines: [
        exp({
          product: 'anything',
          product_id: '00000000-0000-4000-8000-0000000000aa',
        }),
      ],
    });
    expect(scoreCase(c, outcome(utterance(), [line()])).lines_ok).toBe(1);
  });

  it('a wrong quantity fails the line but keeps the price right', () => {
    const s = scoreCase(
      mkCase(),
      outcome(utterance(), [line({ quantity: 3 })]),
    );
    expect(s).toMatchObject({
      lines_ok: 0,
      quantity_ok: 0,
      price_ok: 1,
      exact: false,
    });
  });

  it('checks a spoken price exactly and refuses an invented one', () => {
    const spoken = mkCase({ lines: [exp({ unit_price: 20000 })] });
    const right = line({ unit_price: 20000, price_source: 'spoken' });
    expect(scoreCase(spoken, outcome(utterance(), [right])).price_ok).toBe(1);
    const wrong = line({ unit_price: 20, price_source: 'spoken' });
    expect(scoreCase(spoken, outcome(utterance(), [wrong])).price_ok).toBe(0);
    const invented = line({ unit_price: 20000, price_source: 'spoken' });
    expect(scoreCase(mkCase(), outcome(utterance(), [invented])).price_ok).toBe(
      0,
    );
  });

  it('counts a missing line and an extra line', () => {
    const c = mkCase({
      lines: [exp(), exp({ product: 'Pepsi lon 320ml', spoken: 'pepsi' })],
    });
    const missing = scoreCase(c, outcome(utterance(), [line()]));
    expect(missing.lines_ok).toBe(1);
    expect(missing.exact).toBe(false);
    const extra = scoreCase(
      mkCase(),
      outcome(utterance(), [line(), line({ name: 'Sprite lon 320ml' })]),
    );
    expect(extra.extra_lines).toBe(1);
    expect(extra.exact).toBe(false);
  });

  it('matches an unknown line by status and spoken words', () => {
    const c = mkCase({
      lines: [
        exp({
          spoken: 'gạo ST25',
          product: null,
          unit_price: 35000,
          quantity: 1,
        }),
      ],
    });
    const unknown = line({
      name: null,
      status: 'unknown',
      spoken: 'gạo st25',
      quantity: 1,
      unit_price: 35000,
      price_source: 'spoken',
    });
    expect(scoreCase(c, outcome(utterance(), [unknown])).lines_ok).toBe(1);
    // A matched guess for a product the store lacks is wrong.
    const guessed = line({
      spoken: 'gạo st25',
      quantity: 1,
      unit_price: 35000,
      price_source: 'spoken',
    });
    expect(scoreCase(c, outcome(utterance(), [guessed])).lines_ok).toBe(0);
  });

  it('treats a 422 no_speech as intent none', () => {
    const c = mkCase({
      intent: 'none',
      transcript: '',
      lines: [],
      payment_method: undefined,
    });
    const o: VoiceOutcome = {
      case_id: 'v01',
      status: 422,
      error_code: 'no_speech',
      wall_ms: 900,
    };
    expect(actualIntent(o)).toBe('none');
    const s = scoreCase(c, o);
    expect(s).toMatchObject({ intent_ok: true, error: null, exact: true });
  });

  it('flags other failures as errors', () => {
    const o: VoiceOutcome = {
      case_id: 'v01',
      status: 503,
      error_code: 'voice_unavailable',
      wall_ms: 10,
    };
    const s = scoreCase(mkCase(), o);
    expect(s.error).toBe('voice_unavailable');
    expect(s.intent_ok).toBe(false);
  });

  it('a chat reply carries no draft', () => {
    const c = mkCase({
      intent: 'chat',
      lines: [],
      payment_method: undefined,
      transcript: 'hôm nay bán được bao nhiêu',
    });
    const s = scoreCase(
      c,
      outcome(
        utterance({ intent: 'chat', transcript: 'hôm nay bán được bao nhiêu' }),
      ),
    );
    expect(s).toMatchObject({ intent_ok: true, exact: true });
    expect(s.wer?.edits).toBe(0);
  });

  it('checks payment and the credit customer', () => {
    const c = mkCase({ payment_method: 'credit', customer_name: 'chị Lan' });
    const draftWith = (customer: unknown) => {
      const o = outcome(utterance(), [line()], 'credit');
      (o.utterance!.sale_draft as Draft).customer =
        customer as Draft['customer'];
      return o;
    };
    const ok = scoreCase(
      c,
      draftWith({
        status: 'matched',
        spoken_name: 'chị Lan',
        customer: { name: 'Lan' },
      }),
    );
    expect(ok).toMatchObject({
      payment_ok: true,
      customer_ok: true,
      exact: true,
    });
    const bad = scoreCase(
      c,
      draftWith({ status: 'none', spoken_name: 'chị Hoa' }),
    );
    expect(bad.customer_ok).toBe(false);
    expect(
      scoreCase(c, outcome(utterance(), [line()], 'cash')).payment_ok,
    ).toBe(false);
  });

  it('reports a diacritics-stripped WER next to the strict one', () => {
    const s = scoreCase(
      mkCase({ transcript: 'hai chục coca' }),
      outcome(utterance({ transcript: 'hai chuc coca' }), [line()]),
    );
    expect(s.wer).toEqual({ edits: 1, words: 3 });
    expect(s.wer_nodiac).toEqual({ edits: 0, words: 3 });
  });
});

describe('matchLines', () => {
  it('does not reuse one actual line twice', () => {
    const { pairs, extra } = matchLines([exp(), exp()], [line()]);
    expect(pairs.filter(([, a]) => a !== null)).toHaveLength(1);
    expect(extra).toHaveLength(0);
  });
});

describe('aggregate', () => {
  it('pools lines, WER and latency across cases', () => {
    const c1 = mkCase();
    const c2 = mkCase({ id: 'v02', lines: [exp({ unit_price: 20000 })] });
    const o1 = outcome(utterance(), [line()]);
    const o2 = {
      ...outcome(utterance({ transcript: 'hai lon' }), [line()]),
      case_id: 'v02',
      wall_ms: 3000,
    };
    const scores = [scoreCase(c1, o1), scoreCase(c2, o2)];
    const a = aggregate(scores, [o1, o2]);
    expect(a.cases).toBe(2);
    expect(a.line_accuracy).toBe(0.5);
    expect(a.price_accuracy).toBe(0.5);
    expect(a.quantity_accuracy).toBe(1);
    expect(a.wer).toBeCloseTo(1 / 6);
    expect(a.latency_p50_ms).toBe(1500);
    expect(a.latency_p95_ms).toBe(3000);
    expect(a.server_latency_p50_ms).toBe(1200);
    expect(a.cost_per_utterance_usd).toBeNull();
    expect(a.pass).toBe(false);
  });

  it('averages the cost over the cases that report one and passes at the bars', () => {
    const c = mkCase();
    const o1 = outcome(utterance(), [line()], 'cash', { cost_usd: 0.001 });
    const o2 = { ...outcome(utterance(), [line()]), cost_usd: 0.003 };
    const a = aggregate([scoreCase(c, o1), scoreCase(c, o2)], [o1, o2]);
    expect(a.cost_per_utterance_usd).toBeCloseTo(0.002);
    expect(a.cost_n).toBe(2);
    expect(a.pass).toBe(true);
  });

  it('is all n/a for no cases', () => {
    const a = aggregate([], []);
    expect(a.line_accuracy).toBeNull();
    expect(a.pass).toBe(true);
  });
});
