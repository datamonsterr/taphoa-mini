import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_BUDGET, evaluate, parseGfxinfo } from './gfxinfo-budget.mjs';

const fixture = readFileSync(
  new URL('./__fixtures__/gfxinfo.txt', import.meta.url),
  'utf8',
);

test('parses totals, janky frames and p90 from dumpsys output', () => {
  assert.deepEqual(parseGfxinfo(fixture), {
    totalFrames: 1204,
    jankyFrames: 187,
    jankyPercent: 15.53,
    p90Ms: 28,
  });
});

test('ignores the legacy janky line and gpu percentiles', () => {
  const stats = parseGfxinfo(fixture);
  assert.notEqual(stats.jankyPercent, 25);
  assert.notEqual(stats.p90Ms, 9);
});

test('within budget passes', () => {
  assert.deepEqual(evaluate(parseGfxinfo(fixture)), []);
});

test('defaults are a catastrophic-regression guard for the software-GPU emulator', () => {
  assert.deepEqual(DEFAULT_BUDGET, { maxJankyPercent: 98, maxP90Ms: 500 });
});

test('the first real swiftshader run (90.59 % janky, p90 250 ms) passes', () => {
  assert.deepEqual(
    evaluate({
      totalFrames: 2000,
      jankyFrames: 1812,
      jankyPercent: 90.59,
      p90Ms: 250,
    }),
    [],
  );
});

test('fails on janky percentage and on p90', () => {
  const failures = evaluate({
    totalFrames: 100,
    jankyFrames: 99,
    jankyPercent: 99,
    p90Ms: 600,
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /janky/);
  assert.match(failures[1], /p90/);
});

test('limits are inclusive', () => {
  const { maxJankyPercent, maxP90Ms } = DEFAULT_BUDGET;
  assert.deepEqual(
    evaluate({
      totalFrames: 10,
      jankyFrames: 1,
      jankyPercent: maxJankyPercent,
      p90Ms: maxP90Ms,
    }),
    [],
  );
});

test('a custom budget overrides the defaults', () => {
  const stats = {
    totalFrames: 10,
    jankyFrames: 5,
    jankyPercent: 50,
    p90Ms: 80,
  };
  assert.deepEqual(evaluate(stats), []);
  assert.equal(
    evaluate(stats, { maxJankyPercent: 25, maxP90Ms: 50 }).length,
    2,
  );
});

test('unparseable or empty output fails', () => {
  assert.equal(evaluate(parseGfxinfo('nothing here')).length, 1);
  assert.equal(
    evaluate({ totalFrames: 0, jankyFrames: 0, jankyPercent: 0, p90Ms: 0 })
      .length,
    1,
  );
});
