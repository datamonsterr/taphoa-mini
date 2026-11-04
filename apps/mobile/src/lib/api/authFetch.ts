import { clerkToken, membershipRequired, pinRequired } from './clerkBridge';

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
  // `membership_required` says the person has no membership at all. Inside a store (the request
  // carried X-Store-Id) a plain `forbidden` can also mean they were removed from that one while
  // keeping another, so either way `/me` is re-read and the selected store falls back.
  const inspect = async (response: Response, inStore: boolean) => {
    if (response.status === 403) {
      const code = await responseCode(response);
      if (code === 'membership_required' || (inStore && code === 'forbidden'))
        membershipRequired();
      // The server locks a person's session when someone else takes the phone (or after a long
      // idle): the app goes back to the person picker, which asks for the PIN.
      if (code === 'pin_required') pinRequired();
    }
    return response;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (isPublicPath(new URL(request.url).pathname)) return send(request);
    const token = await clerkToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    else request.headers.delete('Authorization');
    const replay = request.clone();
    const inStore = request.headers.has('X-Store-Id');
    const response = await send(request);
    if (
      response.status !== 401 ||
      !token ||
      (await responseCode(response)) === 'invalid_pin'
    )
      return inspect(response, inStore);
    const fresh = await clerkToken({ skipCache: true });
    if (!fresh) return response;
    replay.headers.set('Authorization', `Bearer ${fresh}`);
    return inspect(await send(replay), inStore);
  }) as typeof fetch;
}
