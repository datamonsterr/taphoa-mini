import { useSessionStore, type Session } from '@/stores/session';

/** Routes that run without a session (or create one): never get a bearer token or a refresh retry. */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/v1/stores',
  '/v1/auth/join',
  '/v1/auth/recover',
  '/v1/auth/refresh',
]);

export const isPublicPath = (pathname: string) => PUBLIC_PATHS.has(pathname);

type AuthSessionBody = {
  access_token: string;
  refresh_token: string;
  member: Session['member'];
  store: Session['store'];
};

export type AuthFetchOptions = {
  baseUrl: string;
  /** The transport underneath; defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/**
 * A `fetch` that signs requests with the stored access token. On a 401 it rotates the refresh
 * token once (a single flight shared by every request that failed meanwhile), stores the new
 * pair and replays the request. If the server refuses the refresh, the session is cleared and the
 * root layout routes back to onboarding. A network error or 5xx on refresh keeps the session: the
 * phone may just be offline.
 */
export function createAuthFetch({
  baseUrl,
  fetch: transport,
}: AuthFetchOptions): typeof fetch {
  const send = (input: Request): Promise<Response> =>
    (transport ?? globalThis.fetch)(input);

  let inflight: Promise<'ok' | 'rejected' | 'unreachable'> | null = null;

  async function rotate(): Promise<'ok' | 'rejected' | 'unreachable'> {
    const current = useSessionStore.getState().session;
    if (!current) return 'rejected';
    try {
      const response = await send(
        new Request(`${baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refresh_token }),
        }),
      );
      if (response.ok) {
        const body = (await response.json()) as AuthSessionBody;
        useSessionStore.getState().setSession({
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          member: body.member,
          store: body.store,
        });
        return 'ok';
      }
      if (response.status >= 500) return 'unreachable';
      useSessionStore.getState().clear();
      return 'rejected';
    } catch {
      return 'unreachable';
    }
  }

  /** One refresh at a time: the second 401 awaits the first one's outcome. */
  const refreshOnce = () => {
    inflight ??= rotate().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (isPublicPath(new URL(request.url).pathname)) return send(request);

    // The body is a one-shot stream: keep a copy for the replay.
    const replay = request.clone();
    const usedToken = useSessionStore.getState().session?.access_token;
    if (usedToken) request.headers.set('Authorization', `Bearer ${usedToken}`);
    const response = await send(request);
    if (response.status !== 401 || !usedToken) return response;

    // Another request may already have rotated the pair while this one was in flight.
    const latest = useSessionStore.getState().session?.access_token;
    if (latest === usedToken) {
      const outcome = await refreshOnce();
      if (outcome !== 'ok') return response;
    } else if (!latest) {
      return response;
    }
    const token = useSessionStore.getState().session?.access_token;
    if (token) replay.headers.set('Authorization', `Bearer ${token}`);
    return send(replay);
  }) as typeof fetch;
}
