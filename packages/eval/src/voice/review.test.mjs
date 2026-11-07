import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { reviewedSubset } from './cases.ts';

test('only explicitly reviewed cases can be scored', () => {
  const cases = [
    { id: 'pending', review_status: 'unreviewed' },
    { id: 'legacy' },
    { id: 'done', review_status: 'reviewed' },
  ];
  deepStrictEqual(
    reviewedSubset(cases).map((c) => c.id),
    ['done'],
  );
});

test('unreviewed incomplete sidecars do not block loading reviewed cases', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadVoiceCases } = await import('./cases.ts');
  const dir = mkdtempSync(join(tmpdir(), 'voice-review-'));
  writeFileSync(
    join(dir, 'pending.json'),
    JSON.stringify({ review_status: 'unreviewed' }),
  );
  deepStrictEqual(loadVoiceCases(dir, true), []);
});
