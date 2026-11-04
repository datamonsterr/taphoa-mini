// Re-score stored voice runs against the current sidecars and fill the cases that failed with an
// upstream error (rate limit, timeout) from re-run files. Writes `<base>-final.{json,md}`.
//   node scripts/voice-merge.ts <label> <base.json> [rerun.json ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadVoiceCases } from '../src/voice/cases.ts';
import {
  renderVoiceMarkdown,
  type VoiceRunReport,
} from '../src/voice/report.ts';
import { aggregate, scoreCase } from '../src/voice/score.ts';
import type { VoiceOutcome } from '../src/voice/types.ts';

const [label, base, ...reruns] = process.argv.slice(2);
if (!label || !base) {
  console.error('usage: voice-merge.ts <label> <base.json> [rerun.json ...]');
  process.exit(2);
}
type Slim = {
  results: {
    case_id: string;
    outcome: Record<string, any>;
    score: { error: string | null };
  }[];
} & Record<string, any>;
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Slim;
const first = read(base);
const picked = new Map(first.results.map((r) => [r.case_id, r]));
for (const f of reruns)
  for (const r of read(f).results)
    if (!r.score.error || !picked.has(r.case_id)) picked.set(r.case_id, r);

const cases = loadVoiceCases();
const results = cases.map((c) => {
  const r = picked.get(c.id)!;
  const o = r.outcome;
  const outcome: VoiceOutcome = {
    case_id: c.id,
    status: o.status,
    error_code: o.error_code,
    wall_ms: o.wall_ms,
    cost_usd: o.cost_usd ?? null,
    utterance: o.utterance_id
      ? ({
          id: o.utterance_id,
          transcript: o.transcript,
          intent: o.intent,
          model: o.model,
          stt_fallback: o.stt_fallback,
          latency_ms: o.latency_ms,
          sale_draft: o.sale_draft,
        } as any)
      : undefined,
  };
  return { case: c, outcome, score: scoreCase(c, outcome) };
});
const report: VoiceRunReport = {
  runId: `${first.runId}+reruns`,
  date: first.date,
  model: label,
  set: 'full',
  backendHost: first.backendHost,
  gitSha: first.gitSha,
  aggregate: aggregate(
    results.map((r) => r.score),
    results.map((r) => r.outcome),
  ),
  results,
  notRun: [],
  aborted: null,
};
const out = base.replace(/\.json$/, '-final');
const slim = {
  ...report,
  results: results.map(({ case: c, outcome, score }) => ({
    case_id: c.id,
    intent: c.intent,
    tags: c.tags,
    source: c.source,
    score,
    outcome: { ...picked.get(c.id)!.outcome, status: outcome.status },
  })),
};
writeFileSync(`${out}.json`, `${JSON.stringify(slim, null, 2)}\n`);
writeFileSync(`${out}.md`, renderVoiceMarkdown(report));
console.log(`${out}.{json,md}`, JSON.stringify(report.aggregate));
