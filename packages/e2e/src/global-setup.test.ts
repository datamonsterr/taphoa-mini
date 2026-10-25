import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const deleteUser = vi.hoisted(() => vi.fn());
vi.mock('./clerk.js', () => ({ deleteUser }));
import setup from './global-setup.js';

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  delete process.env.CLERK_TRACKING_DIR;
  vi.unstubAllEnvs();
  deleteUser.mockReset();
});

it('reads all worker journals, deduplicates IDs and removes the directory', async () => {
  vi.stubEnv('CLERK_SECRET_KEY', 'unit-secret');
  const teardown = setup();
  directory = process.env.CLERK_TRACKING_DIR!;
  writeFileSync(join(directory, 'worker-1.jsonl'), '"user_1"\n"user_2"\n');
  writeFileSync(join(directory, 'worker-2.jsonl'), '"user_2"\n"user_3"\n');
  await teardown();
  expect(deleteUser.mock.calls).toEqual([['user_1'], ['user_2'], ['user_3']]);
  expect(existsSync(directory)).toBe(false);
});

it('attempts all deletions on failure and retains the journals', async () => {
  vi.stubEnv('CLERK_SECRET_KEY', 'unit-secret');
  const teardown = setup();
  directory = process.env.CLERK_TRACKING_DIR!;
  writeFileSync(join(directory, 'worker.jsonl'), '"user_1"\n"user_2"\n');
  deleteUser
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValue(undefined);
  await expect(teardown()).rejects.toThrow('cleanup failed for 1 users');
  expect(deleteUser).toHaveBeenCalledTimes(2);
  expect(
    readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'),
  ).toContain('user_1');
});

it('requires credentials before allocating a tracking directory', () => {
  vi.stubEnv('CLERK_SECRET_KEY', '');
  expect(() => setup()).toThrow('CLERK_SECRET_KEY');
});
