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
