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

  it('honors a configured lower request rate', async () => {
    vi.stubEnv('CLERK_BAPI_RPS', '2');
    const times: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        times.push(Date.now());
        return Promise.resolve(reply({ id: 'session_1' }));
      }),
    );
    const clerk = await import('./clerk.js');
    const calls = [
      clerk.createSession('user_1'),
      clerk.createSession('user_2'),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(times[1] - times[0]).toBe(500);
  });

  it('rejects an invalid request rate', async () => {
    vi.stubEnv('CLERK_BAPI_RPS', '0');
    const clerk = await import('./clerk.js');
    await expect(clerk.createSession('user_1')).rejects.toThrow(
      'CLERK_BAPI_RPS',
    );
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
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer test-secret',
    );
  });

  it('puts only the Clerk error code in the failure message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              { code: 'quota_exceeded', message: 'secret-ish', meta: { a: 1 } },
            ],
          }),
          { status: 403 },
        ),
      ),
    );
    const clerk = await import('./clerk.js');
    const error = await clerk
      .createUser({ email: 'a+clerk_test@example.com' })
      .catch((e: Error) => e);
    expect((error as Error).message).toBe(
      'Clerk Backend API POST failed: HTTP 403 (quota_exceeded)',
    );
  });

  it('explains the user cap and the sweep command on user_quota_exceeded, without the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ code: 'user_quota_exceeded', message: 'secret-ish' }],
          }),
          { status: 403 },
        ),
      ),
    );
    const clerk = await import('./clerk.js');
    const error = await clerk
      .createUser({ email: 'a+clerk_test@example.com' })
      .catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain('HTTP 403 (user_quota_exceeded)');
    expect(message).toContain('user cap (100 on development instances)');
    expect(message).toContain(
      'pnpm --filter @taphoa/e2e clerk:sweep --max-age-hours 2',
    );
    expect(message).not.toContain('secret-ish');
  });

  it.each([
    ['not json'],
    [JSON.stringify({ errors: [] })],
    [JSON.stringify({ errors: [{ code: 'bad code with spaces' }] })],
  ])('omits the code when the body has no usable one: %s', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status: 500 })),
    );
    const clerk = await import('./clerk.js');
    await expect(clerk.createSession('user_1')).rejects.toThrow(
      /^Clerk Backend API POST failed: HTTP 500$/,
    );
  });

  describe('eager deletion', () => {
    const created = async () => {
      let n = 0;
      const fetch = vi.fn((url: string, init: RequestInit) => {
        if (init.method === 'POST')
          return Promise.resolve(reply({ id: `user_${++n}` }));
        return Promise.resolve(reply({ deleted: true }));
      });
      vi.stubGlobal('fetch', fetch);
      const clerk = await import('./clerk.js');
      for (let i = 0; i < 3; i++) {
        const p = clerk.createUser({
          email: `e2e-${i}+clerk_test@example.com`,
        });
        await vi.runAllTimersAsync();
        await p;
      }
      return { clerk, fetch };
    };

    it('deletes every tracked user and forgets them', async () => {
      const { clerk, fetch } = await created();
      expect(clerk.liveUserIds()).toEqual(['user_1', 'user_2', 'user_3']);
      const done = clerk.deleteCreatedUsers();
      await vi.runAllTimersAsync();
      expect(await done).toEqual([]);
      expect(clerk.liveUserIds()).toEqual([]);
      expect(
        fetch.mock.calls
          .filter(([, init]) => init.method === 'DELETE')
          .map(([url]) => String(url)),
      ).toEqual([
        'https://clerk.invalid/v1/users/user_1',
        'https://clerk.invalid/v1/users/user_2',
        'https://clerk.invalid/v1/users/user_3',
      ]);
    });

    it('deletes only the given ids', async () => {
      const { clerk } = await created();
      const done = clerk.deleteCreatedUsers(['user_2']);
      await vi.runAllTimersAsync();
      await done;
      expect(clerk.liveUserIds()).toEqual(['user_1', 'user_3']);
    });

    it('keeps failures tracked and reports them without throwing', async () => {
      const { clerk } = await created();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{}', { status: 500 })),
      );
      const done = clerk.deleteCreatedUsers();
      await vi.runAllTimersAsync();
      expect(await done).toEqual(['user_1', 'user_2', 'user_3']);
      expect(clerk.liveUserIds()).toHaveLength(3);
    });

    it('treats an already deleted user (404) as deleted', async () => {
      const { clerk } = await created();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{}', { status: 404 })),
      );
      const done = clerk.deleteCreatedUsers(['user_1']);
      await vi.runAllTimersAsync();
      expect(await done).toEqual([]);
      expect(clerk.liveUserIds()).toEqual(['user_2', 'user_3']);
    });
  });
});
