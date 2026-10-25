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
      await response.body?.cancel();
      // Do not include response bodies: they can contain identity data or tokens.
      throw new Error(
        `Clerk Backend API ${method} failed: HTTP ${response.status}`,
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
  await request('DELETE', `/users/${encodeURIComponent(id)}`);
  createdUsers.delete(id);
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
