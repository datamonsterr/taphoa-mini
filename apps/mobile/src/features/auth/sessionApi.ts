import { createApiClient } from '@taphoa/api-client';

import { apiBaseUrl } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { Me } from '@/lib/api/store';

/** The part of a Clerk session resource this module needs. */
export type TokenSource = {
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>;
};

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    return ((await response.clone().json()) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

/**
 * Signs a request as one given Clerk session, which need not be the active one. Mirrors the
 * active client: one replay of a 401 with a fresh token, but never of a wrong PIN, so a single
 * entry cannot burn two attempts. The network is read at call time so tests can stand in for it.
 */
function sessionFetch(session: TokenSource): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const replay = request.clone();
    const token = await session.getToken();
    if (!token)
      return Response.json(
        { error: 'No Clerk session token', code: 'unauthorized' },
        { status: 401 },
      );
    request.headers.set('Authorization', `Bearer ${token}`);
    const response = await globalThis.fetch(request);
    if (
      response.status !== 401 ||
      (await responseCode(response)) === 'invalid_pin'
    )
      return response;
    const fresh = await session.getToken({ skipCache: true });
    if (!fresh) return response;
    replay.headers.set('Authorization', `Bearer ${fresh}`);
    return globalThis.fetch(replay);
  }) as typeof fetch;
}

const clientFor = (session: TokenSource, storeId?: string) =>
  createApiClient({
    baseUrl: apiBaseUrl(),
    getStoreId: () => storeId,
    fetch: sessionFetch(session),
  }).raw;

/** `GET /v1/me` as that session: who they are and which stores they belong to. */
export const fetchSessionMe = (session: TokenSource): Promise<Me> =>
  unwrap(clientFor(session).GET('/v1/me'));

/** `POST /v1/me/pin/verify` as that session in that store; resolves on 204, throws `ApiError` otherwise. */
export async function verifySessionPin(
  session: TokenSource,
  storeId: string,
  pin: string,
): Promise<void> {
  await unwrap(
    clientFor(session, storeId).POST('/v1/me/pin/verify', { body: { pin } }),
  );
}

/**
 * `POST /v1/me/pin/lock` as that session: from now on the server refuses it with `pin_required`
 * until its PIN is verified again. Best effort: the person has already stopped being the active
 * one, so a failure (offline, session already gone) must not interrupt the switch.
 */
export async function lockSession(session: TokenSource): Promise<void> {
  try {
    await unwrap(clientFor(session).POST('/v1/me/pin/lock'));
  } catch {
    // The session lock then waits for its idle timeout on the server.
  }
}
