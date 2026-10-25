import type { Aggregate } from './scorers/aggregate.ts';
import type { CaseScore, GoldenCase } from './types.ts';

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
export const DISTINCT_ID = 'eval-harness';

/** Where eval events go. `capture` is synchronous; `flush` sends what is queued. */
export interface EventSink {
  capture(event: string, properties: Record<string, unknown>): void;
  /** Resolves true when everything was delivered. Never rejects for a delivery problem. */
  flush(): Promise<boolean>;
}

export class NoopSink implements EventSink {
  capture(_event: string, _properties: Record<string, unknown>) {}
  async flush() {
    return true;
  }
}

/** Keeps events in memory, for tests and dry runs. */
export class MemorySink implements EventSink {
  readonly events: { event: string; properties: Record<string, unknown> }[] =
    [];

  capture(event: string, properties: Record<string, unknown>) {
    this.events.push({ event, properties });
  }

  async flush() {
    return true;
  }
}

type Queued = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
};

/**
 * Batches events to the PostHog capture API (`POST <host>/batch/`). Every
 * event carries `distinct_id: eval-harness`, `environment: eval` and
 * `$process_person_profile: false`. A failed flush logs a warning (never the
 * token) and returns false.
 */
export class PostHogSink implements EventSink {
  readonly token: string;
  readonly host: string;
  readonly fetchFn: typeof fetch;
  readonly now: () => Date;
  readonly warn: (message: string) => void;
  readonly batchSize: number;
  readonly timeoutMs: number;
  queue: Queued[] = [];

  constructor(opts: {
    token: string;
    host?: string;
    fetch?: typeof fetch;
    now?: () => Date;
    warn?: (message: string) => void;
    batchSize?: number;
    timeoutMs?: number;
  }) {
    this.token = opts.token;
    this.host = (opts.host ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.batchSize = opts.batchSize ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  capture(event: string, properties: Record<string, unknown>) {
    this.queue.push({
      event,
      distinct_id: DISTINCT_ID,
      properties: {
        distinct_id: DISTINCT_ID,
        environment: 'eval',
        $process_person_profile: false,
        ...properties,
      },
      timestamp: this.now().toISOString(),
    });
  }

  async flush(): Promise<boolean> {
    const events = this.queue;
    this.queue = [];
    let ok = true;
    for (let i = 0; i < events.length; i += this.batchSize) {
      const batch = events.slice(i, i + this.batchSize);
      try {
        const res = await this.fetchFn(`${this.host}/batch/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: this.token, batch }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          ok = false;
          this.warn(
            `PostHog rejected ${batch.length} eval events: HTTP ${res.status} from ${this.host}`,
          );
        }
      } catch (e) {
        ok = false;
        this.warn(
          `PostHog flush of ${batch.length} eval events failed: ${(e as Error).message}`,
        );
      }
    }
    return ok;
  }
}

export type EventContext = {
  runId: string;
  model: string;
  set: 'smoke' | 'full' | 'partial';
  judgeModel: string | null;
};

/** Properties of one `eval_case_scored` event. */
export function caseScoredProperties(
  ctx: EventContext,
  c: GoldenCase,
  score: CaseScore,
): Record<string, unknown> {
  return {
    eval_run_id: ctx.runId,
    model: ctx.model,
    case_id: score.case_id,
    use_case: score.use_case,
    scorer: score.scorer,
    value: score.value,
    set: ctx.set,
    judge_model: ctx.judgeModel,
    tags: c.tags,
  };
}

/**
 * Properties of `eval_run_completed`: the run facts, then one property per
 * pass-bar metric with a `<metric>_pass` flag. A metric no case contributed
 * to is null and passes.
 */
export function runCompletedProperties(
  run: EventContext & {
    cases: number;
    errors: number;
    pending: number;
    aggregate: Aggregate;
    gitSha: string;
    resultsFile: string;
  },
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    eval_run_id: run.runId,
    model: run.model,
    set: run.set,
    judge_model: run.judgeModel,
    cases: run.cases,
    errors: run.errors,
    pending: run.pending,
    pass: run.aggregate.pass,
    git_sha: run.gitSha,
    results_file: run.resultsFile,
  };
  for (const row of run.aggregate.rows) {
    props[row.metric] = row.value;
    props[`${row.metric}_pass`] = row.pass;
  }
  return props;
}
