import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('CLERK_SECRET_KEY', 'test-secret');
  vi.stubEnv('CLERK_API_URL', 'https://clerk.invalid');
  vi.stubEnv('CLERK_BAPI_RPS', '8');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const reply = (body: unknown) => new Response(JSON.stringify(body));

describe('Clerk Backend API', () => {
  it('fails clearly without a secret before making a request', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const clerk = await import('./clerk.js');
    await expect(clerk.createSession('user_1')).rejects.toThrow(
      'CLERK_SECRET_KEY',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('spaces concurrent requests at 8 per second', async () => {
    const times: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        times.push(Date.now());
        return Promise.resolve(reply({ id: 'session_1' }));
      }),
    );
    const clerk = await import('./clerk.js');
    const calls = Array.from({ length: 10 }, () =>
      clerk.createSession('user_1'),
    );
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(times).toHaveLength(10);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(125);
  });

  it.each([
    ['3', 3000],
    [null, 2000],
  ])('retries 429 after Retry-After %s', async (header, delay) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: header ? { 'Retry-After': header } : {},
        }),
      )
      .mockResolvedValue(reply({ jwt: 'jwt-test' }));
    vi.stubGlobal('fetch', fetch);
    const clerk = await import('./clerk.js');
    const result = clerk.createSessionToken('session_1');
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('jwt-test');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after five retries without exposing response secrets', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('sensitive token', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const clerk = await import('./clerk.js');
    const result = expect(clerk.createSession('user_1')).rejects.toThrow(
      'HTTP 429',
    );
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('uses the exact user, session and token request bodies and list response', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ id: 'user_1' }))
      .mockResolvedValueOnce(reply({ id: 'session_1' }))
      .mockResolvedValueOnce(reply({ jwt: 'jwt-test' }))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply({ deleted: true }));
    vi.stubGlobal('fetch', fetch);
    const clerk = await import('./clerk.js');
    const work = (async () => {
      await clerk.createUser({
        email: 'a+clerk_test@example.com',
        firstName: 'A',
        lastName: 'B',
      });
      await clerk.createSession('user_1');
      expect(await clerk.createSessionToken('session_1')).toBe('jwt-test');
      expect(await clerk.listUsers({ limit: 100, offset: 0 })).toEqual([]);
      await clerk.deleteUser('user_1');
    })();
    await vi.runAllTimersAsync();
    await work;
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://clerk.invalid/v1/users',
      'https://clerk.invalid/v1/sessions',
      'https://clerk.invalid/v1/sessions/session_1/tokens',
      'https://clerk.invalid/v1/users?limit=100&offset=0',
      'https://clerk.invalid/v1/users/user_1',
    ]);
    expect(
      fetch.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(init.body)),
    ).toEqual([
      {
        email_address: ['a+clerk_test@example.com'],
        first_name: 'A',
        last_name: 'B',
        skip_password_requirement: true,
      },
      { user_id: 'user_1' },
      { expires_in_seconds: 3600 },
    ]);
    expect(fetch.mock.calls[4][1].method).toBe('DELETE');
  });
});
