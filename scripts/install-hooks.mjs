import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Docker source archives do not include .git; hooks belong to developer checkouts.
if (existsSync('.git')) {
  const result = spawnSync('lefthook', ['install'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
