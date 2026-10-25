import { describe, expect, it, vi } from 'vitest';
import { CachedAuth, EnvAuth, STUB_TOKENS, StubAuth } from './auth.ts';

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
