import type { VoiceUtterance } from '@taphoa/api-client';
import {
  normalizeVi,
  percentile,
  stripDiacritics,
  werParts,
  werPartsNoDiacritics,
} from './normalize.ts';
import type {
  CaseScore,
  ExpectedLine,
  LineStatus,
  VoiceCase,
  VoiceOutcome,
} from './types.ts';

type ActualLine = NonNullable<VoiceUtterance['sale_draft']>['lines'][number];

/** Pass bars for the default model (DoD row 5). */
export const VOICE_BARS = { line_accuracy: 0.9, price_accuracy: 0.97 } as const;

const statusOf = (l: ExpectedLine): LineStatus =>
  l.status ?? (l.product === null ? 'unknown' : 'matched');

/** Share of the expected spoken tokens found in the actual text (diacritics ignored). */
function overlap(expected: string, actual: string): number {
  const want = stripDiacritics(expected).split(' ').filter(Boolean);
  const have = new Set(stripDiacritics(actual).split(' ').filter(Boolean));
  if (want.length === 0) return 0;
  return want.filter((t) => have.has(t)).length / want.length;
}

/** Does this actual line stand for the expected one (same product or same unknown words)? */
function sameProduct(exp: ExpectedLine, act: ActualLine): boolean {
  const status = statusOf(exp);
  if (status === 'matched') {
    if (exp.product_id && act.product?.id === exp.product_id) return true;
    if (!exp.product || !act.product?.name) return false;
    return normalizeVi(act.product.name) === normalizeVi(exp.product);
  }
  // Unknown or ambiguous: the status must agree and the spoken words must be alike.
  return act.status === status && overlap(exp.spoken, act.spoken) >= 0.5;
}

function priceOk(exp: ExpectedLine, act: ActualLine): boolean {
  if (exp.unit_price === null) return act.price_source !== 'spoken';
  return act.unit_price === exp.unit_price;
}

/**
 * Pair each expected line with an actual line, in order, taking the first unused
 * actual line of the same product. Returns the pairs and the unused actual lines.
 */
export function matchLines(
  expected: ExpectedLine[],
  actual: ActualLine[],
): { pairs: [ExpectedLine, ActualLine | null][]; extra: ActualLine[] } {
  const used = new Set<number>();
  const pairs = expected.map((exp): [ExpectedLine, ActualLine | null] => {
    const i = actual.findIndex((a, k) => !used.has(k) && sameProduct(exp, a));
    if (i < 0) return [exp, null];
    used.add(i);
    return [exp, actual[i]!];
  });
  return { pairs, extra: actual.filter((_, k) => !used.has(k)) };
}

/** Intent of a reply; a 422 `no_speech` is the answer "none". */
export function actualIntent(o: VoiceOutcome): string | null {
  if (o.utterance) return o.utterance.intent;
  if (o.status === 422 && o.error_code === 'no_speech') return 'none';
  return null;
}

function customerOk(
  expected: string,
  draft: NonNullable<VoiceUtterance['sale_draft']>,
): boolean {
  const c = draft.customer;
  if (!c) return false;
  const want = stripDiacritics(expected)
    .split(' ')
    .filter((t) => !['chi', 'anh', 'co', 'chu', 'bac', 'em'].includes(t));
  const names = [c.spoken_name, c.customer?.name].filter(
    (n): n is string => typeof n === 'string',
  );
  return names.some((n) => {
    const have = stripDiacritics(n);
    return want.length > 0 && want.every((t) => have.split(' ').includes(t));
  });
}

export function scoreCase(c: VoiceCase, o: VoiceOutcome): CaseScore {
  const intent = actualIntent(o);
  const error =
    intent === null ? `${o.error_code ?? 'http_' + o.status}` : null;
  const draft = o.utterance?.sale_draft;
  const lines_expected = c.lines.length;
  const base: CaseScore = {
    case_id: c.id,
    tags: c.tags,
    error,
    intent_ok: intent === c.intent,
    wer: null,
    wer_nodiac: null,
    lines_expected,
    lines_ok: 0,
    quantity_ok: 0,
    price_ok: 0,
    extra_lines: 0,
    exact: false,
    payment_ok: null,
    customer_ok: null,
  };
  if (o.utterance && c.transcript !== '') {
    base.wer = werParts(c.transcript, o.utterance.transcript);
    base.wer_nodiac = werPartsNoDiacritics(
      c.transcript,
      o.utterance.transcript,
    );
  }
  const actualLines = draft?.lines ?? [];
  const { pairs, extra } = matchLines(c.lines, actualLines);
  base.extra_lines = extra.length;
  for (const [exp, act] of pairs) {
    if (!act) continue;
    const q = act.quantity === exp.quantity;
    const p = priceOk(exp, act);
    if (q) base.quantity_ok++;
    if (p) base.price_ok++;
    if (q && p) base.lines_ok++;
  }
  if (c.payment_method)
    base.payment_ok = draft?.payment_method === c.payment_method;
  if (c.customer_name)
    base.customer_ok = draft ? customerOk(c.customer_name, draft) : false;
  base.exact =
    error === null &&
    base.intent_ok &&
    base.lines_ok === lines_expected &&
    base.extra_lines === 0 &&
    base.payment_ok !== false &&
    base.customer_ok !== false &&
    (c.intent === 'sale' || draft === undefined);
  return base;
}

export type VoiceAggregate = {
  cases: number;
  errors: number;
  wer: number | null;
  wer_nodiac: number | null;
  line_accuracy: number | null;
  price_accuracy: number | null;
  quantity_accuracy: number | null;
  intent_accuracy: number | null;
  payment_accuracy: number | null;
  customer_accuracy: number | null;
  exact_rate: number | null;
  extra_lines: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  server_latency_p50_ms: number | null;
  server_latency_p95_ms: number | null;
  cost_per_utterance_usd: number | null;
  cost_n: number;
  pass: boolean;
};

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function aggregate(
  scores: CaseScore[],
  outcomes: VoiceOutcome[],
): VoiceAggregate {
  const werOf = (pick: (s: CaseScore) => CaseScore['wer']) => {
    const parts = scores.map(pick).filter((p) => p !== null);
    return ratio(
      sum(parts.map((p) => p.edits)),
      sum(parts.map((p) => p.words)),
    );
  };
  const lines = sum(scores.map((s) => s.lines_expected));
  const payment = scores.filter((s) => s.payment_ok !== null);
  const customer = scores.filter((s) => s.customer_ok !== null);
  const answered = outcomes.filter((o) => o.utterance);
  const costs = outcomes
    .map((o) => o.cost_usd)
    .filter((x): x is number => typeof x === 'number');
  const line_accuracy = ratio(sum(scores.map((s) => s.lines_ok)), lines);
  const price_accuracy = ratio(sum(scores.map((s) => s.price_ok)), lines);
  return {
    cases: scores.length,
    errors: scores.filter((s) => s.error !== null).length,
    wer: werOf((s) => s.wer),
    wer_nodiac: werOf((s) => s.wer_nodiac),
    line_accuracy,
    price_accuracy,
    quantity_accuracy: ratio(sum(scores.map((s) => s.quantity_ok)), lines),
    intent_accuracy: ratio(
      scores.filter((s) => s.intent_ok).length,
      scores.length,
    ),
    payment_accuracy: ratio(
      payment.filter((s) => s.payment_ok).length,
      payment.length,
    ),
    customer_accuracy: ratio(
      customer.filter((s) => s.customer_ok).length,
      customer.length,
    ),
    exact_rate: ratio(scores.filter((s) => s.exact).length, scores.length),
    extra_lines: sum(scores.map((s) => s.extra_lines)),
    latency_p50_ms: percentile(
      answered.map((o) => o.wall_ms),
      50,
    ),
    latency_p95_ms: percentile(
      answered.map((o) => o.wall_ms),
      95,
    ),
    server_latency_p50_ms: percentile(
      answered.map((o) => o.utterance!.latency_ms),
      50,
    ),
    server_latency_p95_ms: percentile(
      answered.map((o) => o.utterance!.latency_ms),
      95,
    ),
    cost_per_utterance_usd:
      costs.length === 0 ? null : sum(costs) / costs.length,
    cost_n: costs.length,
    pass:
      (line_accuracy ?? 1) >= VOICE_BARS.line_accuracy - 1e-9 &&
      (price_accuracy ?? 1) >= VOICE_BARS.price_accuracy - 1e-9,
  };
}
