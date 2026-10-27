import type { Role } from '../types.ts';

/**
 * Headers that authenticate one request as a member of the eval store. The
 * runner asks for them on every request, so an implementation may refresh a
 * short-lived token behind this call.
 */
export interface AuthProvider {
  headersFor(role: Role): Promise<Record<string, string>>;
}

/** A credential the runner needs is not configured. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/** Tokens `StubAuth` sends; the stub assistant derives the role from them. */
export const STUB_TOKENS: Record<Role, string> = {
  lead: 'stub-lead-token',
  seller: 'stub-seller-token',
};

function bearer(token: string, storeId: string | undefined) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (storeId) headers['X-Store-Id'] = storeId;
  return headers;
}

/** Fixed tokens, for dry runs against the stub assistant. */
export class StubAuth implements AuthProvider {
  readonly tokens: Record<Role, string>;
  readonly storeId: string | undefined;

  constructor(opts: { tokens?: Record<Role, string>; storeId?: string } = {}) {
    this.tokens = opts.tokens ?? STUB_TOKENS;
    this.storeId = opts.storeId;
  }

  async headersFor(role: Role) {
    return bearer(this.tokens[role], this.storeId);
  }
}

const TOKEN_VARS: Record<Role, string> = {
  lead: 'EVAL_LEAD_TOKEN',
  seller: 'EVAL_SELLER_TOKEN',
};

/**
 * Bearer tokens from `EVAL_LEAD_TOKEN` and `EVAL_SELLER_TOKEN`, plus an
 * optional `EVAL_STORE_ID` sent as `X-Store-Id`. Errors name the variable and
 * never show a value.
 */
export class EnvAuth implements AuthProvider {
  readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  async headersFor(role: Role) {
    const name = TOKEN_VARS[role];
    const token = this.env[name]?.trim();
    if (!token) {
      throw new AuthConfigError(
        `${name} is not set (needed for ${role} cases)`,
      );
    }
    return bearer(token, this.env.EVAL_STORE_ID?.trim() || undefined);
  }
}

export type MintedToken = { token: string; expiresAtMs: number };

/**
 * Tokens minted on demand (Clerk, task T7) and cached per role. A token is
 * reused until `refreshBeforeMs` before it expires; concurrent callers share
 * one mint, and a failed mint is not cached.
 */
export class CachedAuth implements AuthProvider {
  readonly mint: (role: Role) => Promise<MintedToken>;
  readonly storeId: string | undefined;
  readonly refreshBeforeMs: number;
  readonly now: () => number;
  readonly cache = new Map<Role, MintedToken>();
  readonly pending = new Map<Role, Promise<MintedToken>>();

  constructor(opts: {
    mint: (role: Role) => Promise<MintedToken>;
    storeId?: string;
    /** Default 15 s: Clerk session tokens live 60 s. */
    refreshBeforeMs?: number;
    now?: () => number;
  }) {
    this.mint = opts.mint;
    this.storeId = opts.storeId;
    this.refreshBeforeMs = opts.refreshBeforeMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async headersFor(role: Role) {
    const cached = this.cache.get(role);
    if (cached && this.now() < cached.expiresAtMs - this.refreshBeforeMs) {
      return bearer(cached.token, this.storeId);
    }
    let pending = this.pending.get(role);
    if (!pending) {
      pending = this.mint(role).then(
        (minted) => {
          this.cache.set(role, minted);
          this.pending.delete(role);
          return minted;
        },
        (error: unknown) => {
          this.pending.delete(role);
          throw error;
        },
      );
      this.pending.set(role, pending);
    }
    return bearer((await pending).token, this.storeId);
  }
}

/** The eval store used when `EVAL_STORE_ID` is not set (`seed/eval`). */
export const DEFAULT_EVAL_STORE_ID = 'e7a10e7a-0000-4000-8000-000000000000';

/**
 * Clerk test users the eval seed creates, one per role. The email is
 * `seed-<store key>-<member key>+clerk_test@example.com` with store key `eval`
 * (`seed::clerk::member_email`); STORE.md lists the member keys.
 */
export const LEAD_EMAIL = 'seed-eval-co-ba+clerk_test@example.com';
export const SELLER_EMAIL = 'seed-eval-be-na+clerk_test@example.com';
const ROLE_EMAIL: Record<Role, string> = {
  lead: LEAD_EMAIL,
  seller: SELLER_EMAIL,
};

const MAX_429_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 60_000;

function decodeJwtExpMs(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tokens for the two seeded Clerk test users, minted through the Clerk Backend
 * API of a development instance: find the user by email, create a session
 * (`POST /v1/sessions`, development only), then `POST /v1/sessions/{id}/tokens`.
 *
 * The Backend API allows 100 requests per 10 s for everyone, so tokens are
 * cached per role and refreshed 10 s before they expire, one request runs at a
 * time, and a 429 waits for `Retry-After`. Errors name a status and never a
 * response body or the secret key.
 */
export class ClerkAuth implements AuthProvider {
  readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly tokenTtlSeconds: number;
  private readonly cached: CachedAuth;
  private readonly userIds = new Map<Role, string>();
  private readonly sessionIds = new Map<Role, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    secretKey: string;
    /** Default `https://api.clerk.com`. */
    apiUrl?: string;
    storeId?: string;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Default 10 s. */
    refreshBeforeMs?: number;
    /** Default 60. */
    tokenTtlSeconds?: number;
  }) {
    const secretKey = opts.secretKey.trim();
    if (!secretKey) throw new AuthConfigError('CLERK_SECRET_KEY is empty');
    this.secretKey = secretKey;
    this.baseUrl = (opts.apiUrl?.trim() || 'https://api.clerk.com').replace(
      /\/+$/,
      '',
    );
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? 60;
    this.cached = new CachedAuth({
      mint: (role) => this.mintToken(role),
      storeId: opts.storeId,
      refreshBeforeMs: opts.refreshBeforeMs ?? 10_000,
      now: this.now,
    });
  }

  /** `null` when `CLERK_SECRET_KEY` is not set. */
  static fromEnv(
    env: Record<string, string | undefined>,
    fetchFn?: typeof fetch,
  ): ClerkAuth | null {
    const secretKey = env.CLERK_SECRET_KEY?.trim();
    if (!secretKey) return null;
    return new ClerkAuth({
      secretKey,
      apiUrl: env.CLERK_API_URL,
      storeId: env.EVAL_STORE_ID?.trim() || DEFAULT_EVAL_STORE_ID,
      fetch: fetchFn,
    });
  }

  headersFor(role: Role) {
    return this.cached.headersFor(role);
  }

  /** One bearer token for a role, bypassing the cache (pre-flight checks). */
  async mintToken(role: Role): Promise<MintedToken> {
    let sessionId = this.sessionIds.get(role) ?? (await this.openSession(role));
    let jwt = await this.tokenOf(sessionId);
    if (jwt === null) {
      // The session ended (revoked or expired): open a new one once.
      this.sessionIds.delete(role);
      sessionId = await this.openSession(role);
      jwt = await this.tokenOf(sessionId);
    }
    if (jwt === null) {
      throw new Error('Clerk Backend API token request failed: HTTP 404');
    }
    return {
      token: jwt,
      expiresAtMs:
        decodeJwtExpMs(jwt) ?? this.now() + this.tokenTtlSeconds * 1000,
    };
  }

  /** The Clerk user id behind a role; throws `AuthConfigError` when missing. */
  async userId(role: Role): Promise<string> {
    const known = this.userIds.get(role);
    if (known) return known;
    const email = ROLE_EMAIL[role];
    const users = (await this.call(
      'GET',
      `/v1/users?${new URLSearchParams({ email_address: email })}`,
      'user lookup',
    )) as { id?: unknown }[];
    const id = users[0]?.id;
    if (typeof id !== 'string' || !id) {
      throw new AuthConfigError(
        `Clerk user ${email} not found for the ${role} role: seed the eval store with CLERK_SECRET_KEY set (taphoa-seed --profile eval)`,
      );
    }
    this.userIds.set(role, id);
    return id;
  }

  private async openSession(role: Role): Promise<string> {
    const userId = await this.userId(role);
    const session = (await this.call('POST', '/v1/sessions', 'session', {
      user_id: userId,
    })) as { id?: unknown };
    if (typeof session.id !== 'string' || !session.id) {
      throw new Error('Clerk Backend API session response has no id');
    }
    this.sessionIds.set(role, session.id);
    return session.id;
  }

  /** The JWT of a session, or `null` when the session no longer exists. */
  private async tokenOf(sessionId: string): Promise<string | null> {
    const result = (await this.call(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tokens`,
      'token',
      { expires_in_seconds: this.tokenTtlSeconds },
      [404],
    )) as { jwt?: unknown } | null;
    if (result === null) return null;
    if (typeof result.jwt !== 'string' || !result.jwt) {
      throw new Error('Clerk Backend API token response has no jwt');
    }
    return result.jwt;
  }

  /** Serialised: the next request starts when the previous one finished. */
  private call(
    method: string,
    path: string,
    label: string,
    body?: unknown,
    nullOn: number[] = [],
  ): Promise<unknown> {
    const run = this.queue.then(() =>
      this.send(method, path, label, body, nullOn),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    method: string,
    path: string,
    label: string,
    body: unknown,
    nullOn: number[],
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        const seconds = Number(response.headers.get('Retry-After') ?? 2);
        await response.body?.cancel();
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : 2;
        await this.sleep(Math.min(wait * 1000, MAX_RETRY_WAIT_MS));
        continue;
      }
      if (nullOn.includes(response.status)) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Clerk Backend API ${label} request failed: HTTP ${response.status}`,
        );
      }
      return response.json();
    }
  }
}
