import { describe, expect, it, vi } from 'vitest';
import {
  AuthConfigError,
  CachedAuth,
  ClerkAuth,
  EnvAuth,
  LEAD_EMAIL,
  SELLER_EMAIL,
  STUB_TOKENS,
  StubAuth,
} from './auth.ts';

describe('StubAuth', () => {
  it('sends a fixed bearer token per role', async () => {
    const auth = new StubAuth();
    expect(await auth.headersFor('lead')).toEqual({
      Authorization: `Bearer ${STUB_TOKENS.lead}`,
    });
    expect(await auth.headersFor('seller')).toEqual({
      Authorization: `Bearer ${STUB_TOKENS.seller}`,
    });
  });

  it('adds X-Store-Id when a store is configured', async () => {
    const auth = new StubAuth({ storeId: 'store-1' });
    expect(await auth.headersFor('lead')).toEqual({
      Authorization: `Bearer ${STUB_TOKENS.lead}`,
      'X-Store-Id': 'store-1',
    });
  });
});

describe('EnvAuth', () => {
  const env = {
    EVAL_LEAD_TOKEN: 'lead-secret',
    EVAL_SELLER_TOKEN: 'seller-secret',
  };

  it('reads the token of each role from the environment', async () => {
    const auth = new EnvAuth(env);
    expect(await auth.headersFor('lead')).toEqual({
      Authorization: 'Bearer lead-secret',
    });
    expect(await auth.headersFor('seller')).toEqual({
      Authorization: 'Bearer seller-secret',
    });
  });

  it('sends EVAL_STORE_ID as X-Store-Id', async () => {
    const auth = new EnvAuth({ ...env, EVAL_STORE_ID: 'store-9' });
    expect((await auth.headersFor('lead'))['X-Store-Id']).toBe('store-9');
  });

  it('names the missing variable, never a secret value', async () => {
    const auth = new EnvAuth({ EVAL_LEAD_TOKEN: 'lead-secret' });
    const err = (await auth
      .headersFor('seller')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('EVAL_SELLER_TOKEN');
    expect(err.message).not.toContain('lead-secret');
  });

  it('treats a blank token as missing', async () => {
    const auth = new EnvAuth({ EVAL_LEAD_TOKEN: '  ' });
    await expect(auth.headersFor('lead')).rejects.toThrow('EVAL_LEAD_TOKEN');
  });
});

describe('CachedAuth', () => {
  function setup(ttlMs = 60_000) {
    let now = 1_000_000;
    let n = 0;
    const mint = vi.fn(async (role: string) => {
      n++;
      return { token: `${role}-${n}`, expiresAtMs: now + ttlMs };
    });
    const auth = new CachedAuth({
      mint,
      refreshBeforeMs: 15_000,
      now: () => now,
    });
    return {
      auth,
      mint,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('mints once per role and reuses the token', async () => {
    const { auth, mint } = setup();
    const a = await auth.headersFor('lead');
    const b = await auth.headersFor('lead');
    await auth.headersFor('seller');
    expect(a).toEqual({ Authorization: 'Bearer lead-1' });
    expect(b).toEqual(a);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('refreshes a token shortly before it expires', async () => {
    const { auth, mint, advance } = setup(60_000);
    await auth.headersFor('lead');
    advance(44_000);
    expect((await auth.headersFor('lead')).Authorization).toBe('Bearer lead-1');
    advance(2_000); // 46 s: inside the 15 s refresh window
    expect((await auth.headersFor('lead')).Authorization).toBe('Bearer lead-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('shares one mint between concurrent callers', async () => {
    const { auth, mint } = setup();
    const all = await Promise.all([
      auth.headersFor('lead'),
      auth.headersFor('lead'),
      auth.headersFor('lead'),
    ]);
    expect(new Set(all.map((h) => h.Authorization)).size).toBe(1);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed mint', async () => {
    let calls = 0;
    const auth = new CachedAuth({
      mint: async () => {
        calls++;
        if (calls === 1) throw new Error('clerk down');
        return { token: 't', expiresAtMs: Date.now() + 60_000 };
      },
    });
    await expect(auth.headersFor('lead')).rejects.toThrow('clerk down');
    expect((await auth.headersFor('lead')).Authorization).toBe('Bearer t');
  });

  it('adds X-Store-Id when configured', async () => {
    const auth = new CachedAuth({
      mint: async () => ({ token: 't', expiresAtMs: Date.now() + 60_000 }),
      storeId: 's1',
    });
    expect((await auth.headersFor('lead'))['X-Store-Id']).toBe('s1');
  });
});

describe('ClerkAuth', () => {
  const SECRET = 'sk_test_secret_value';
  const USERS: Record<string, string> = {
    [LEAD_EMAIL]: 'user_lead',
    [SELLER_EMAIL]: 'user_seller',
  };

  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (sub: string, n: number, exp: number) =>
    `${b64({ alg: 'none' })}.${b64({ sub, n, exp })}.sig`;

  type Call = { method: string; url: URL; headers: Headers; body: unknown };

  function setup(
    opts: {
      respond?: (call: Call, n: number) => Response | undefined;
      ttl?: number;
      apiUrl?: string;
      storeId?: string;
    } = {},
  ) {
    let now = 1_000_000_000_000; // ms
    const calls: Call[] = [];
    const sleeps: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let tokens = 0;
    let sessions = 0;
    const fetchFn = vi.fn(async (input: URL | string, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        const call: Call = {
          method: init?.method ?? 'GET',
          url: new URL(String(input)),
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        const custom = opts.respond?.(call, calls.length);
        if (custom) return custom;
        const path = call.url.pathname;
        if (call.method === 'GET' && path === '/v1/users') {
          const id = USERS[call.url.searchParams.get('email_address') ?? ''];
          return Response.json(id ? [{ id }] : []);
        }
        if (call.method === 'POST' && path === '/v1/sessions') {
          sessions++;
          return Response.json({
            id: `sess_${(call.body as { user_id: string }).user_id}_${sessions}`,
          });
        }
        const m = /^\/v1\/sessions\/(.+)\/tokens$/.exec(path);
        if (call.method === 'POST' && m) {
          tokens++;
          const ttl = (call.body as { expires_in_seconds: number })
            .expires_in_seconds;
          return Response.json({
            jwt: jwt(m[1]!, tokens, Math.floor(now / 1000) + (opts.ttl ?? ttl)),
          });
        }
        return new Response('nope', { status: 500 });
      } finally {
        inFlight--;
      }
    });
    const auth = new ClerkAuth({
      secretKey: SECRET,
      apiUrl: opts.apiUrl,
      storeId: opts.storeId,
      fetch: fetchFn as unknown as typeof fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return {
      auth,
      calls,
      sleeps,
      fetchFn,
      advance: (ms: number) => {
        now += ms;
      },
      maxInFlight: () => maxInFlight,
    };
  }

  it('uses the seeded eval emails', () => {
    expect(LEAD_EMAIL).toBe('seed-eval-co-ba+clerk_test@example.com');
    expect(SELLER_EMAIL).toBe('seed-eval-be-na+clerk_test@example.com');
  });

  it('finds the user, opens a session and mints a bearer token', async () => {
    const { auth, calls } = setup({ storeId: 'store-1' });
    const headers = await auth.headersFor('lead');
    expect(headers['X-Store-Id']).toBe('store-1');
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.sig$/);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v1/users',
      'POST /v1/sessions',
      'POST /v1/sessions/sess_user_lead_1/tokens',
    ]);
    // The plus sign of the +clerk_test sub-address must be percent-encoded.
    expect(calls[0]!.url.search).toBe(
      `?email_address=${encodeURIComponent(LEAD_EMAIL)}`,
    );
    expect(calls[1]!.body).toEqual({ user_id: 'user_lead' });
    expect(calls[2]!.body).toEqual({ expires_in_seconds: 60 });
    for (const c of calls) {
      expect(c.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    }
  });

  it('finds the seller by the seller email', async () => {
    const { auth, calls } = setup();
    await auth.headersFor('seller');
    expect(calls[0]!.url.searchParams.get('email_address')).toBe(SELLER_EMAIL);
    expect(calls[1]!.body).toEqual({ user_id: 'user_seller' });
  });

  it('defaults to api.clerk.com and honours CLERK_API_URL', async () => {
    const a = setup();
    await a.auth.headersFor('lead');
    expect(a.calls[0]!.url.origin).toBe('https://api.clerk.com');
    const b = setup({ apiUrl: 'https://clerk.example.test/' });
    await b.auth.headersFor('lead');
    expect(b.calls[0]!.url.href).toMatch(
      /^https:\/\/clerk\.example\.test\/v1\/users\?/,
    );
  });

  it('sends no X-Store-Id without a store', async () => {
    const { auth } = setup();
    expect(await auth.headersFor('lead')).not.toHaveProperty('X-Store-Id');
  });

  it('caches the token and refreshes it 10 s before it expires', async () => {
    const { auth, calls, advance } = setup();
    const first = (await auth.headersFor('lead')).Authorization;
    advance(49_000);
    expect((await auth.headersFor('lead')).Authorization).toBe(first);
    expect(calls).toHaveLength(3);
    advance(2_000); // 51 s: inside the 10 s window of a 60 s token
    const second = (await auth.headersFor('lead')).Authorization;
    expect(second).not.toBe(first);
    // Only the token call repeats: the user and the session are reused.
    expect(calls.slice(3).map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /v1/sessions/sess_user_lead_1/tokens',
    ]);
  });

  it('caches per role', async () => {
    const { auth, calls } = setup();
    const lead = await auth.headersFor('lead');
    const seller = await auth.headersFor('seller');
    expect(lead.Authorization).not.toBe(seller.Authorization);
    await auth.headersFor('lead');
    await auth.headersFor('seller');
    expect(calls).toHaveLength(6);
  });

  it('opens a new session when the session is gone', async () => {
    let gone = false;
    const { auth, calls, advance } = setup({
      respond: (call) => {
        if (
          gone &&
          /\/sessions\/sess_user_lead_1\/tokens$/.test(call.url.pathname)
        ) {
          return new Response('{}', { status: 404 });
        }
        return undefined;
      },
    });
    await auth.headersFor('lead');
    advance(55_000);
    gone = true;
    const headers = await auth.headersFor('lead');
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(calls.at(-2)!.url.pathname).toBe('/v1/sessions');
    expect(calls.at(-1)!.url.pathname).toBe(
      '/v1/sessions/sess_user_lead_2/tokens',
    );
  });

  it('waits for Retry-After on a 429 and retries', async () => {
    let limited = 0;
    const { auth, sleeps } = setup({
      respond: (call) => {
        if (call.url.pathname === '/v1/users' && limited++ < 2) {
          return new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '3' },
          });
        }
        return undefined;
      },
    });
    expect((await auth.headersFor('lead')).Authorization).toMatch(/^Bearer /);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('gives up when 429 persists', async () => {
    const { auth } = setup({
      respond: () =>
        new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
    });
    await expect(auth.headersFor('lead')).rejects.toThrow('429');
  });

  it('keeps at most one request in flight', async () => {
    const { auth, maxInFlight, calls } = setup();
    await Promise.all([
      auth.headersFor('lead'),
      auth.headersFor('seller'),
      auth.headersFor('lead'),
      auth.headersFor('seller'),
    ]);
    expect(maxInFlight()).toBe(1);
    expect(calls).toHaveLength(6);
  });

  it('fails clearly, with the email, when the user does not exist', async () => {
    const { auth } = setup({
      respond: (call) =>
        call.url.pathname === '/v1/users' ? Response.json([]) : undefined,
    });
    const err = (await auth
      .headersFor('lead')
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthConfigError);
    expect(err.message).toContain(LEAD_EMAIL);
    expect(err.message).not.toContain(SECRET);
  });

  it('reports a failed call without its body or the secret', async () => {
    const { auth } = setup({
      respond: (call) =>
        call.url.pathname === '/v1/sessions'
          ? new Response(`secret-body ${SECRET}`, { status: 403 })
          : undefined,
    });
    const err = (await auth
      .headersFor('lead')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('403');
    expect(err.message).not.toContain('secret-body');
    expect(err.message).not.toContain(SECRET);
  });

  it('refuses a blank secret key', () => {
    expect(() => new ClerkAuth({ secretKey: '  ' })).toThrow(AuthConfigError);
  });

  it('can be built from the environment', () => {
    expect(ClerkAuth.fromEnv({})).toBeNull();
    expect(ClerkAuth.fromEnv({ CLERK_SECRET_KEY: ' ' })).toBeNull();
    expect(ClerkAuth.fromEnv({ CLERK_SECRET_KEY: SECRET })).toBeInstanceOf(
      ClerkAuth,
    );
  });
});
