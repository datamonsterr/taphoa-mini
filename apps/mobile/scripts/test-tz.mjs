#!/usr/bin/env node
// Runs the date-sensitive jest suites under UTC and Asia/Ho_Chi_Minh with the clock frozen just
// before and just after local midnight (+07). TEST_NOW is read by src/test/after-env.ts.
// Business date must not depend on the process TZ or on the wall clock of the CI runner.
import { spawnSync } from 'node:child_process';

const SUITES = [
  'src/lib/date.test.ts',
  'src/lib/mock',
  'src/lib/api',
  'src/features/expense',
  'src/features/dashboard',
  'src/features/account',
  'src/features/pay',
];
const ZONES = ['UTC', 'Asia/Ho_Chi_Minh'];
const CLOCKS = ['2026-10-23T23:59:00+07:00', '2026-10-24T00:05:00+07:00'];

let failed = false;
for (const TZ of ZONES) {
  for (const TEST_NOW of CLOCKS) {
    console.log(`\n== TZ=${TZ} TEST_NOW=${TEST_NOW}`);
    const run = spawnSync(
      'pnpm',
      ['exec', 'jest', '--runInBand', '--silent', ...SUITES],
      { stdio: 'inherit', env: { ...process.env, TZ, TEST_NOW } },
    );
    if (run.status !== 0) failed = true;
  }
}
process.exit(failed ? 1 : 0);
