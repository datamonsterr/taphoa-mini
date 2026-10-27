import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClerkUser {
  id: string;
  created_at: number;
  email_addresses: { email_address: string }[];
}

// One queue per process, shared by all callers, including retries and cleanup.
let queue = Promise.resolve();
let nextRequestAt = 0;
const createdUsers = new Set<string>();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireSlot(): Promise<void> {
  const rps = Number(process.env.CLERK_BAPI_RPS ?? 8);
  if (!Number.isFinite(rps) || rps <= 0) {
    throw new Error('CLERK_BAPI_RPS must be a positive number');
  }
  const slot = queue.then(async () => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + Math.ceil(1000 / rps);
  });
  queue = slot.catch(() => {});
  return slot;
}

/** Clerk's `errors[0].code` (e.g. `quota_exceeded`) when the body has one; never anything else. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { errors?: { code?: unknown }[] };
    const code = body.errors?.[0]?.code;
    return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret?.trim()) {
    throw new Error('CLERK_SECRET_KEY is required for live Clerk e2e runs');
  }
  const baseUrl = (
    process.env.CLERK_API_URL ?? 'https://api.clerk.com'
  ).replace(/\/+$/, '');
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    const response = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 429 && attempt < 5) {
      const seconds = Number(response.headers.get('Retry-After') ?? 2);
      await response.body?.cancel();
      await sleep(
        (Number.isFinite(seconds) && seconds >= 0 ? seconds : 2) * 1000,
      );
      continue;
    }
    if (!response.ok) {
      const code = await errorCode(response);
      if (code === 'user_quota_exceeded') {
        throw new Error(
          `Clerk Backend API ${method} failed: HTTP ${response.status} (user_quota_exceeded): the Clerk instance hit its user cap (100 on development instances). Delete leaked test users with: pnpm --filter @taphoa/e2e clerk:sweep --max-age-hours 2`,
        );
      }
      // Only the error code, never the body: it can contain identity data or tokens.
      throw new Error(
        `Clerk Backend API ${method} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`,
      );
    }
    return (await response.json()) as T;
  }
}

export async function createUser(options: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<ClerkUser> {
  const user = await request<ClerkUser>('POST', '/users', {
    email_address: [options.email],
    skip_password_requirement: true,
    ...(options.firstName === undefined
      ? {}
      : { first_name: options.firstName }),
    ...(options.lastName === undefined ? {} : { last_name: options.lastName }),
  });
  createdUsers.add(user.id);
  // Global setup supplies a run-specific directory inherited by Vitest workers.
  // Each process appends only to its own file; no inter-worker write race.
  if (process.env.CLERK_TRACKING_DIR) {
    appendFileSync(
      join(process.env.CLERK_TRACKING_DIR, `${process.pid}.jsonl`),
      `${JSON.stringify(user.id)}\n`,
      { mode: 0o600 },
    );
  }
  return user;
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await request('DELETE', `/users/${encodeURIComponent(id)}`);
  } catch (error) {
    // Already gone (deleted eagerly, then again by the global teardown): nothing to do.
    if (!(error instanceof Error && error.message.includes('HTTP 404')))
      throw error;
  }
  createdUsers.delete(id);
}

/** Ids of the users this process created and has not deleted yet. */
export const liveUserIds = (): string[] => [...createdUsers];

/**
 * Deletes the users this process created (all of them, or only `ids`) right away, so a run
 * holds few users at once: the Clerk development instance is capped at 100 users. Best effort:
 * the ones that fail stay tracked for the global teardown and `clerk:sweep`. Returns the failures.
 */
export async function deleteCreatedUsers(
  ids: Iterable<string> = createdUsers,
): Promise<string[]> {
  const failed: string[] = [];
  for (const id of [...ids]) {
    try {
      await deleteUser(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

export function listUsers(
  filters: {
    email_address_query?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ClerkUser[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    query.set(key, String(value));
  return request('GET', `/users${query.size ? `?${query}` : ''}`);
}

/** Testing only: Clerk does not allow this endpoint on production instances. */
export function createSession(userId: string): Promise<{ id: string }> {
  return request('POST', '/sessions', { user_id: userId });
}

export async function createSessionToken(
  sessionId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const result = await request<{ jwt: string }>(
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/tokens`,
    { expires_in_seconds: expiresInSeconds },
  );
  return result.jwt;
}
