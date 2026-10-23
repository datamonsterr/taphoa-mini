#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

if (!process.env.BACKEND_URL) {
  console.log('BACKEND_URL is unset; skipping e2e tests.');
  process.exit(0);
}

const result = spawnSync('vitest', ['run'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
