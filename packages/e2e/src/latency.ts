/** Nearest-rank percentile, with a quantile in [0, 1]. Does not mutate samples. */
export function percentile(
  samples: readonly number[],
  quantile: number,
): number {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError('quantile must be between 0 and 1');
  }
  if (
    samples.length === 0 ||
    samples.some((ms) => !Number.isFinite(ms) || ms < 0)
  ) {
    throw new RangeError(
      'latency samples must be nonempty, finite and nonnegative',
    );
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}

/** A baseline-adjusted estimate; health RTT also includes health handler time. */
export function decideLatency(
  samples: readonly number[],
  {
    budgetMs,
    quantile = 0.95,
    baselineMs = 0,
  }: { budgetMs: number; quantile?: number; baselineMs?: number },
) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError('budgetMs must be finite and positive');
  }
  if (!Number.isFinite(baselineMs) || baselineMs < 0) {
    throw new RangeError('baselineMs must be finite and nonnegative');
  }
  const clientMs = percentile(samples, quantile);
  const adjustedMs = Math.max(0, clientMs - baselineMs);
  return {
    clientMs,
    baselineMs,
    adjustedMs,
    budgetMs,
    quantile,
    passes: adjustedMs < budgetMs,
  };
}

/** Fail early on invalid probe configuration instead of silently collecting no samples. */
export function latencySampleCount(
  value: string | undefined,
  fallback: number,
): number {
  const count = Number(value ?? fallback);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(
      'latency sample count must be a positive safe integer',
    );
  }
  return count;
}
