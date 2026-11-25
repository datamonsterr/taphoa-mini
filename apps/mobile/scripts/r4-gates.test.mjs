import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gates, percentile, readTimings } from './r4-gates.mjs';

const logcat = `
11-25 10:00:01.000  1234  5678 I ReactNativeJS: 'enroll.one_trip_completed', { duration_ms: 12400, shot_count: 3, voice_used: true }
11-25 10:00:02.000  1234  5678 I ReactNativeJS: 'scan.tap_to_result', { duration_ms: 2100, ok: true, detection_count: 2 }
11-25 10:00:03.000  1234  5678 I ReactNativeJS: 'scan.tap_to_result', { duration_ms: 20004, ok: false, detection_count: 0 }
11-25 10:00:04.000  1234  5678 I ReactNativeJS: 'receipt.tap_to_navigation', { duration_ms: 900 }
enroll.one_trip_completed {"duration_ms":15000,"shot_count":3,"voice_used":false}
`;

test('reads both events from logcat and browser console lines', () => {
  assert.deepEqual(readTimings(logcat), {
    enroll: [12400, 15000],
    scan: [2100, 20004],
    scanFailures: 1,
  });
});

test('percentile uses the nearest rank', () => {
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  assert.equal(percentile(values, 50), 1000);
  assert.equal(percentile(values, 95), 1900);
  assert.equal(percentile([], 95), undefined);
});

test('C1 needs ten enrollments with a median of 16 s or less; C3 a p95 of 8 s or less', () => {
  const ten = {
    enroll: Array(10).fill(14000),
    scan: Array(20).fill(3000),
    scanFailures: 0,
  };
  assert.deepEqual(
    gates(ten).map((g) => [g.id, g.pass]),
    [
      ['C1', true],
      ['C3', true],
    ],
  );
  const few = { enroll: [1000], scan: [9000, 9000], scanFailures: 0 };
  assert.deepEqual(
    gates(few).map((g) => [g.id, g.pass]),
    [
      ['C1', false],
      ['C3', false],
    ],
  );
});
