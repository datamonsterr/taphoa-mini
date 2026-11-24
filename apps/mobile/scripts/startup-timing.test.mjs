import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStartupTiming, summaryMarkdown } from './startup-timing.mjs';

const sampleOutput = `
Starting: Intent { cmp=com.datamonsterr.taphoamini/.MainActivity }
Status: ok
LaunchState: COLD
Activity: com.datamonsterr.taphoamini/.MainActivity
TotalTime: 412
WaitTime: 425
ThisTime: 412
Complete
`;

test('parses TotalTime, WaitTime, ThisTime and LaunchState from am start -W output', () => {
  const result = parseStartupTiming(sampleOutput);
  assert.equal(result.status, 'ok');
  assert.equal(result.launchState, 'COLD');
  assert.equal(result.totalTimeMs, 412);
  assert.equal(result.waitTimeMs, 425);
  assert.equal(result.thisTimeMs, 412);
});

test('handles missing or partial output gracefully', () => {
  const result = parseStartupTiming('Starting: Intent { }');
  assert.equal(result.status, null);
  assert.equal(result.launchState, null);
  assert.equal(result.totalTimeMs, null);
  assert.equal(result.waitTimeMs, null);
  assert.equal(result.thisTimeMs, null);
});

test('generates markdown summary table with first paint time', () => {
  const timing = parseStartupTiming(sampleOutput);
  const md = summaryMarkdown(timing, 'shard a');
  assert.match(md, /### Android startup timing \(shard a\)/);
  assert.match(md, /412 ms/);
  assert.match(md, /Time to first paint/);
});
