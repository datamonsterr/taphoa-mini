import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { listUsers, deleteUser } = vi.hoisted(() => ({
  listUsers: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock('./clerk.ts', () => ({ listUsers, deleteUser }));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const now = Date.now();
const user = (
  id: string,
  ageHours: number,
  email = `${id}+clerk_test@example.com`,
) => ({
  id,
  created_at: now - ageHours * 3600000,
  email_addresses: [{ email_address: email }],
});

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = ['node', 'sweep.ts'];
  listUsers.mockReset();
  deleteUser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it('deletes only test emails strictly older than the default 24h cutoff', async () => {
  listUsers.mockResolvedValue([
    user('old', 25),
    user('boundary', 24),
    user('recent', 1),
    user('ordinary', 100, 'ordinary@example.com'),
  ]);
  await import('./sweep.js');
  expect(listUsers).toHaveBeenCalledWith({
    email_address_query: '+clerk_test',
    limit: 100,
    offset: 0,
  });
  expect(deleteUser.mock.calls).toEqual([['old']]);
});

it('gathers all pages before deleting and honors a custom cutoff', async () => {
  process.argv.push('--max-age-hours', '48');
  const page = Array.from({ length: 100 }, (_, i) => user(`user_${i}`, 49));
  listUsers
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce([user('tail', 25)]);
  deleteUser.mockImplementation(() => {
    expect(listUsers).toHaveBeenCalledTimes(2);
    return Promise.resolve();
  });
  await import('./sweep.js');
  expect(listUsers.mock.calls[1][0].offset).toBe(100);
  expect(deleteUser).toHaveBeenCalledTimes(100);
  expect(deleteUser).not.toHaveBeenCalledWith('tail');
});

it('continues deletion after a failure and returns a failing exit code', async () => {
  listUsers.mockResolvedValue([user('first', 25), user('second', 25)]);
  deleteUser.mockRejectedValueOnce(new Error('failed'));
  await import('./sweep.js');
  expect(deleteUser).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});

it('rejects unsafe cutoff arguments before listing users', async () => {
  process.argv.push('--max-age-hours', '-1');
  await expect(import('./sweep.js')).rejects.toThrow('must be positive');
  expect(listUsers).not.toHaveBeenCalled();
});
