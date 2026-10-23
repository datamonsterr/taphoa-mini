import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { measure, run, table } from './bundle-budget.mjs';

const base = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
after(() => rmSync(base, { recursive: true, force: true }));

const raw = 'a'.repeat(1000);
const dir = join(base, 'js');
mkdirSync(dir);
writeFileSync(join(dir, 'entry-1.js'), raw);
writeFileSync(join(dir, 'chunk-2.js'), 'b'.repeat(500));
writeFileSync(join(dir, 'ignore.map'), 'x'.repeat(9999));

test('measure sums raw bytes of bundle files and skips other files', () => {
  assert.deepEqual(measure(dir, { gzip: false }), { files: 2, bytes: 1500 });
});

test('measure sums gzip bytes per file', () => {
  const expected =
    gzipSync(Buffer.from(raw), { level: 9 }).length +
    gzipSync(Buffer.from('b'.repeat(500)), { level: 9 }).length;
  assert.equal(measure(dir, { gzip: true }).bytes, expected);
});

test('measure throws when the directory holds no bundle', () => {
  const empty = join(base, 'empty');
  mkdirSync(empty);
  assert.throws(() => measure(empty, { gzip: false }), /no bundle files/);
});

test('run flags a target above its budget and prints OVER', () => {
  const targets = (budget) => [{ name: 't', dir: 'js', gzip: false, budget }];
  assert.equal(run(targets(1500), base).ok, true);
  const over = run(targets(1499), base);
  assert.equal(over.ok, false);
  assert.match(table(over.rows), /OVER/);
});
