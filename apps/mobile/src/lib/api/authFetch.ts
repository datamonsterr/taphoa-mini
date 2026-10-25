import { clerkToken, membershipRequired } from './clerkBridge';

export const isPublicPath = (pathname: string) =>
  pathname === '/healthz' || pathname === '/readyz';
export type AuthFetchOptions = { baseUrl: string; fetch?: typeof fetch };

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    return ((await response.clone().json()) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

/** Clerk owns refresh. Replay the preserved request once, then return the server's answer. */
export function createAuthFetch({
  fetch: transport,
}: AuthFetchOptions): typeof fetch {
  const send = (request: Request) => (transport ?? globalThis.fetch)(request);
  const inspect = async (response: Response) => {
    if (
      response.status === 403 &&
      (await responseCode(response)) === 'membership_required'
    )
      membershipRequired();
    return response;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (isPublicPath(new URL(request.url).pathname)) return send(request);
    const token = await clerkToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    else request.headers.delete('Authorization');
    const replay = request.clone();
    const response = await send(request);
    if (
      response.status !== 401 ||
      !token ||
      (await responseCode(response)) === 'invalid_pin'
    )
      return inspect(response);
    const fresh = await clerkToken({ skipCache: true });
    if (!fresh) return response;
    replay.headers.set('Authorization', `Bearer ${fresh}`);
    return inspect(await send(replay));
  }) as typeof fetch;
}
