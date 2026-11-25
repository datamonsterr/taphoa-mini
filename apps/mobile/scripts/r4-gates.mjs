// Reads gate C1 and C3 timings out of a device log and checks them (roadmap R4).
//   adb logcat -d -s ReactNativeJS:I > r4.log && node scripts/r4-gates.mjs r4.log
// Browser console exports work too. Exit code 1 when a gate fails or lacks samples.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LINE =
  /(enroll\.one_trip_completed|scan\.tap_to_result)\W.*?duration_ms\W+(\d+)(.*)/;

export function readTimings(text) {
  const out = { enroll: [], scan: [], scanFailures: 0 };
  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const ms = Number(match[2]);
    if (match[1] === 'enroll.one_trip_completed') out.enroll.push(ms);
    else {
      out.scan.push(ms);
      if (/ok\W+false/.test(match[3])) out.scanFailures++;
    }
  }
  return out;
}

/** Nearest-rank percentile; undefined without samples. */
export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** C1: median of at least 10 enrollments ≤ 16 s. C3: p95 of all scans (failures included) ≤ 8 s. */
export function gates({ enroll, scan }) {
  const c1 = percentile(enroll, 50);
  const c3 = percentile(scan, 95);
  return [
    {
      id: 'C1',
      label: `one-trip enroll median (n=${enroll.length}, need ≥ 10)`,
      value: c1,
      limit: 16_000,
      pass: enroll.length >= 10 && c1 <= 16_000,
    },
    {
      id: 'C3',
      label: `identify p95 (n=${scan.length}, need ≥ 20)`,
      value: c3,
      limit: 8_000,
      pass: scan.length >= 20 && c3 <= 8_000,
    },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const timings = readTimings(readFileSync(file ?? 0, 'utf8'));
  const results = gates(timings);
  for (const g of results)
    console.log(
      `${g.pass ? 'PASS' : 'FAIL'} ${g.id} ${g.label}: ${g.value ?? '-'} ms (limit ${g.limit} ms)`,
    );
  console.log(
    `scan failures (timeouts/errors, counted in p95): ${timings.scanFailures}`,
  );
  process.exit(results.every((g) => g.pass) ? 0 : 1);
}
