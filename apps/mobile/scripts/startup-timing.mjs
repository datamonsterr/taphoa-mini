#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Parses `adb shell am start -W` output for cold start / first paint timing.
 *
 * Example output:
 * Starting: Intent { cmp=com.datamonsterr.taphoamini/.MainActivity }
 * Status: ok
 * LaunchState: COLD
 * Activity: com.datamonsterr.taphoamini/.MainActivity
 * TotalTime: 412
 * WaitTime: 425
 * ThisTime: 412
 * Complete
 */
export function parseStartupTiming(text) {
  const match = (re) => {
    const m = re.exec(text);
    return m ? m[1] : null;
  };
  const num = (re) => {
    const v = match(re);
    return v !== null ? Number(v) : null;
  };

  return {
    status: match(/^\s*Status:\s*(\w+)/m),
    launchState: match(/^\s*LaunchState:\s*(\w+)/m),
    totalTimeMs: num(/^\s*TotalTime:\s*(\d+)/m),
    waitTimeMs: num(/^\s*WaitTime:\s*(\d+)/m),
    thisTimeMs: num(/^\s*ThisTime:\s*(\d+)/m),
  };
}

export function summaryMarkdown(timing, label = '') {
  const showMs = (v) => (v !== null ? `${v} ms` : 'n/a');
  const title = label
    ? `### Android startup timing (${label})`
    : '### Android startup timing (first paint)';

  return [
    title,
    '',
    '| Metric | Value | Description |',
    '| --- | --- | --- |',
    `| TotalTime | ${showMs(timing.totalTimeMs)} | Time to first paint (initial display) |`,
    `| WaitTime | ${showMs(timing.waitTimeMs)} | Total launch time |`,
    `| ThisTime | ${showMs(timing.thisTimeMs)} | Activity display time |`,
    `| LaunchState | ${timing.launchState ?? 'n/a'} | Process launch state |`,
    '',
  ].join('\n');
}

function main(file) {
  const text = readFileSync(file, 'utf8');
  const timing = parseStartupTiming(text);
  const tag = process.env.RUN_TAG || process.env.MATRIX_SHARD || '';
  const md = summaryMarkdown(timing, tag ? `shard ${tag}` : '');
  console.log(md);
  writeFileSync('startup-timing.md', md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('usage: startup-timing.mjs <startup-timing.txt>');
    process.exit(2);
  }
  main(process.argv[2]);
}
