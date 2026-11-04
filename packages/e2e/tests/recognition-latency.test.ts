import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import { decideLatency, latencySampleCount } from '../src/latency.js';
import { form, post, postRetrying } from '../src/recognition-http.js';

// Budget specs run apart from the recognition contracts: Railway's inference latency is noisy,
// so run-e2e.sh runs this file as a soft step.
const LATENCY_BUDGET_MS = Number(process.env.RECOGNITION_BUDGET_MS ?? 3000);
const RUNS = latencySampleCount(process.env.RECOGNITION_RUNS, 12);
// Nearest-rank p90 excludes one outlier at n=12; p95 would still select the max.
const QUANTILE = 0.9;
// Allow twelve successful requests plus busy-slot retries, independently of the budget.
const TEST_TIMEOUT_MS = RUNS * 15_000 + 30_000;

describe('recognition latency', () => {
  it(
    'creates a multi scan within the latency budget and reads it back',
    async () => {
      const store = await createStore();
      const token = store.session.access_token;
      const samples: number[] = [];
      let last: any;
      for (let run = 0; run < RUNS; run++) {
        // Not counted: a busy slot is a retry, only the successful request is timed.
        const result = await postRetrying(
          '/v1/recognition/scans',
          () => form({ mode: 'multi' }),
          token,
        );
        expect(result.status).toBe(201);
        samples.push(result.ms);
        last = result.json;
      }
      const decision = decideLatency(samples, {
        budgetMs: LATENCY_BUDGET_MS,
        quantile: QUANTILE,
      });
      console.info(
        `scan latency ms: ${samples.map((s) => Math.round(s)).join(', ')} p90=${Math.round(decision.adjustedMs)} budget=${LATENCY_BUDGET_MS}`,
      );
      expect(
        decision.passes,
        `recognition p90 ${decision.adjustedMs}ms must be < ${LATENCY_BUDGET_MS}ms`,
      ).toBe(true);

      expect(last.mode).toBe('multi');
      expect(last.purpose).toBe('checkout');
      expect(last.pipeline.segmenter).toBeTruthy();
      expect(last.pipeline.embedder).toBeTruthy();
      expect(last.detections.length).toBeGreaterThanOrEqual(5);
      // Empty catalog: nothing can match.
      for (const detection of last.detections) {
        expect(detection.match).toBe('unknown');
        expect(detection.candidates).toEqual([]);
        expect(detection.bbox).toHaveLength(4);
      }
      for (const key of ['segment', 'embed', 'search', 'total']) {
        expect(typeof last.timings_ms[key]).toBe('number');
      }

      const fetched = await store.client.raw.GET(
        '/v1/recognition/scans/{scanId}',
        {
          params: { path: { scanId: last.id } },
        },
      );
      expect(fetched.response.status).toBe(200);
      expect(fetched.data?.id).toBe(last.id);
      expect(fetched.data?.detections.length).toBe(last.detections.length);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'segments a 1600 px photo within the latency budget',
    async () => {
      const token = (await createStore()).session.access_token;
      const samples: number[] = [];
      let segments: any[] = [];
      for (let run = 0; run < RUNS; run++) {
        let result = await post('/v1/segment', form(), token);
        for (let attempt = 0; result.status === 503 && attempt < 5; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          result = await post('/v1/segment', form(), token);
        }
        expect(result.status).toBe(200);
        samples.push(result.ms);
        segments = result.json;
      }
      const decision = decideLatency(samples, {
        budgetMs: LATENCY_BUDGET_MS,
        quantile: QUANTILE,
      });
      console.info(
        `segment latency ms: ${samples.map((s) => Math.round(s)).join(', ')} p90=${Math.round(decision.adjustedMs)} budget=${LATENCY_BUDGET_MS}`,
      );
      expect(
        decision.passes,
        `recognition p90 ${decision.adjustedMs}ms must be < ${LATENCY_BUDGET_MS}ms`,
      ).toBe(true);
      expect(segments.length).toBeGreaterThanOrEqual(5);
      for (const segment of segments) {
        expect(segment.bbox).toHaveLength(4);
        expect(segment.score).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
