import { VOICE_BARS, type VoiceAggregate } from './score.ts';
import type { CaseScore, VoiceCase, VoiceOutcome } from './types.ts';

export type VoiceCaseResult = {
  case: VoiceCase;
  outcome: VoiceOutcome;
  score: CaseScore;
};

export type VoiceRunReport = {
  runId: string;
  date: string;
  /** `--model`, else the slug the backend reported most often, else `default`. */
  model: string;
  set: 'smoke' | 'full' | 'partial';
  backendHost: string;
  gitSha: string;
  aggregate: VoiceAggregate;
  results: VoiceCaseResult[];
  /** Selected cases that never ran (quota guard, abort). */
  notRun: string[];
  aborted: { code: string; message: string; case_id: string } | null;
};

const pct = (x: number | null) =>
  x === null ? 'n/a' : `${Number((x * 100).toFixed(1))} %`;
const ms = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x)} ms`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(5)}`);
const cell = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** `<dir>/voice-<date>-<model>[-smoke|-partial].<ext>` */
export function voiceResultsName(
  date: string,
  model: string,
  set: VoiceRunReport['set'],
  ext: 'json' | 'md',
): string {
  const suffix = set === 'full' ? '' : `-${set}`;
  return `voice-${date}-${modelSlug(model)}${suffix}.${ext}`;
}

export function renderVoiceMarkdown(run: VoiceRunReport): string {
  const a = run.aggregate;
  const verdict = run.aborted
    ? `ABORTED (${run.aborted.code})`
    : a.pass
      ? 'PASS'
      : 'FAIL';
  const out: string[] = [
    `# Voice eval ${run.date} · ${run.model} · ${run.set}`,
    '',
    `- Verdict: **${verdict}**`,
    `- Run: \`${run.runId}\` · commit \`${run.gitSha}\` · backend ${run.backendHost}`,
    `- Cases: ${a.cases} scored, ${a.errors} with errors, ${run.notRun.length} not run`,
  ];
  if (run.aborted)
    out.push(
      `- Aborted at \`${run.aborted.case_id}\`: ${cell(run.aborted.message)}`,
    );
  out.push(
    '',
    '| Metric | Value | Bar |',
    '| --- | --- | --- |',
    `| Line accuracy (product, quantity, price) | ${pct(a.line_accuracy)} | ≥ ${VOICE_BARS.line_accuracy * 100} % |`,
    `| Price accuracy | ${pct(a.price_accuracy)} | ≥ ${VOICE_BARS.price_accuracy * 100} % |`,
    `| Quantity accuracy | ${pct(a.quantity_accuracy)} | |`,
    `| Intent accuracy | ${pct(a.intent_accuracy)} | |`,
    `| Payment accuracy | ${pct(a.payment_accuracy)} | |`,
    `| Customer accuracy | ${pct(a.customer_accuracy)} | |`,
    `| Cases exactly right | ${pct(a.exact_rate)} | |`,
    `| Extra lines (hallucinated) | ${a.extra_lines} | |`,
    `| WER (diacritics kept) | ${pct(a.wer)} | |`,
    `| WER (diacritics stripped) | ${pct(a.wer_nodiac)} | |`,
    `| Latency p50 / p95 (client) | ${ms(a.latency_p50_ms)} / ${ms(a.latency_p95_ms)} | |`,
    `| Latency p50 / p95 (server) | ${ms(a.server_latency_p50_ms)} / ${ms(a.server_latency_p95_ms)} | |`,
    `| Cost per utterance | ${usd(a.cost_per_utterance_usd)} (${a.cost_n} priced) | ≤ $0.002 |`,
    '',
    '## Cases',
    '',
    '| Case | Intent | Lines | Qty | Price | WER | Client ms | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const { case: c, outcome: o, score: s } of run.results) {
    const wer = s.wer && s.wer.words > 0 ? pct(s.wer.edits / s.wer.words) : '';
    const note = s.error
      ? `error ${s.error}`
      : s.exact
        ? 'ok'
        : [
            !s.intent_ok ? `intent ${o.utterance?.intent ?? '?'}` : '',
            s.extra_lines ? `${s.extra_lines} extra` : '',
            s.payment_ok === false ? 'payment' : '',
            s.customer_ok === false ? 'customer' : '',
          ]
            .filter(Boolean)
            .join(', ') || 'lines';
    out.push(
      `| ${c.id} | ${c.intent} | ${s.lines_ok}/${s.lines_expected} | ${s.quantity_ok}/${s.lines_expected} | ${s.price_ok}/${s.lines_expected} | ${wer} | ${Math.round(o.wall_ms)} | ${cell(note)} |`,
    );
  }
  if (run.notRun.length) out.push('', `Not run: ${run.notRun.join(', ')}`);
  out.push('');
  return out.join('\n');
}
