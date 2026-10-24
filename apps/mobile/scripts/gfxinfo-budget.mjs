#!/usr/bin/env node
// Jank budget gate: parses `adb shell dumpsys gfxinfo <package>` output and fails when the
// app drops too many frames.
//
// The CI emulator renders with swiftshader (software GPU) on shared 4-core runners, far
// slower than any phone (first real run: 90.59 % janky frames, p90 250 ms). Phone-grade
// limits are meaningless there, so the defaults only catch a catastrophic regression
// (for example a render loop that stalls the UI thread):
//   - janky frames > 98 %
//   - 90th percentile frame time > 500 ms
// The table is always printed; the emulator numbers are trend-only. Smoothness on real
// hardware is gated by the web perf spec and the render-count tests (see README).
// Override with JANK_MAX_PERCENT / JANK_MAX_P90_MS.
//
// Usage: gfxinfo-budget.mjs <gfxinfo.txt>
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BUDGET = { maxJankyPercent: 98, maxP90Ms: 500 };

/** Extract the three numbers we gate on; any missing one is `null`. */
export function parseGfxinfo(text) {
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    totalFrames: num(/^\s*Total frames rendered:\s*(\d+)/m),
    // "Janky frames: 187 (15.53%)"; the "(legacy)" line has a different label and is skipped.
    jankyFrames: num(/^\s*Janky frames:\s*(\d+)/m),
    jankyPercent: num(/^\s*Janky frames:\s*\d+\s*\(([\d.]+)%\)/m),
    p90Ms: num(/^\s*90th percentile:\s*(\d+)\s*ms/m),
  };
}

/** Returns the list of violated limits; empty means within budget. */
export function evaluate(stats, budget = DEFAULT_BUDGET) {
  if (
    stats.totalFrames === null ||
    stats.jankyPercent === null ||
    stats.p90Ms === null
  ) {
    return ['could not parse gfxinfo output'];
  }
  if (stats.totalFrames === 0) {
    return ['no frames rendered (was the app in the foreground?)'];
  }
  const failures = [];
  if (stats.jankyPercent > budget.maxJankyPercent) {
    failures.push(
      `janky frames ${stats.jankyPercent}% > ${budget.maxJankyPercent}%`,
    );
  }
  if (stats.p90Ms > budget.maxP90Ms) {
    failures.push(`p90 frame time ${stats.p90Ms} ms > ${budget.maxP90Ms} ms`);
  }
  return failures;
}

export function summaryMarkdown(stats, budget, failures) {
  const show = (v, unit = '') => (v === null ? 'n/a' : `${v}${unit}`);
  return [
    '### Android jank budget',
    '',
    '| Metric | Value | Limit |',
    '| --- | --- | --- |',
    `| Total frames rendered | ${show(stats.totalFrames)} | |`,
    `| Janky frames | ${show(stats.jankyFrames)} (${show(stats.jankyPercent, '%')}) | ≤ ${budget.maxJankyPercent}% |`,
    `| 90th percentile | ${show(stats.p90Ms, ' ms')} | ≤ ${budget.maxP90Ms} ms |`,
    '',
    failures.length ? `**FAIL**: ${failures.join('; ')}` : '**PASS**',
    '',
  ].join('\n');
}

function main(file) {
  const budget = {
    maxJankyPercent: Number(
      process.env.JANK_MAX_PERCENT ?? DEFAULT_BUDGET.maxJankyPercent,
    ),
    maxP90Ms: Number(process.env.JANK_MAX_P90_MS ?? DEFAULT_BUDGET.maxP90Ms),
  };
  const stats = parseGfxinfo(readFileSync(file, 'utf8'));
  const failures = evaluate(stats, budget);
  const md = summaryMarkdown(stats, budget, failures);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(failures.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('usage: gfxinfo-budget.mjs <gfxinfo.txt>');
    process.exit(2);
  }
  main(process.argv[2]);
}
