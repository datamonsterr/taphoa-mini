import type { Me } from '@/lib/api/store';

import { testSession } from './session';

let memberCounter = 0;
type MembershipSpec = {
  storeId: string;
  storeName?: string;
  role?: 'lead' | 'seller';
  hasPin?: boolean;
  memberName?: string;
};

/** A `GET /v1/me` body for another person on the device. */
export function buildMe(options: {
  userId: string;
  name: string | null;
  email?: string | null;
  memberships: MembershipSpec[];
}): Me {
  const { store, member } = testSession();
  return {
    clerk_user_id: options.userId,
    profile: { display_name: options.name, email: options.email ?? null },
    memberships: options.memberships.map((spec) => ({
      store: {
        ...store,
        id: spec.storeId,
        name: spec.storeName ?? `Cửa hàng ${spec.storeId}`,
      },
      member: {
        ...member,
        id: `00000000-0000-4000-8000-${String(++memberCounter).padStart(12, '0')}`,
        display_name: spec.memberName ?? options.name ?? 'Người dùng',
        role: spec.role ?? 'seller',
        can_enroll: spec.role === 'lead',
        has_pin: spec.hasPin ?? false,
      },
    })),
  };
}

export type RecordedRequest = {
  method: string;
  path: string;
  token: string | null;
  storeId: string | null;
  body: unknown;
};

export type PersonScript = {
  me: Me | Response;
  /** The PIN `POST /v1/me/pin/verify` accepts; any other PIN answers 401 `invalid_pin`. */
  pin?: string;
  /** Replaces the PIN check, e.g. a 429 with `Retry-After`. */
  verify?: (pin: string) => Response;
};

/**
 * Stands in for the network that other people's sessions use (their own Clerk token, never the
 * active session's). Requests are keyed by bearer token and recorded.
 */
export function installPeople(people: Record<string, PersonScript>) {
  const requests: RecordedRequest[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    const token =
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const path = new URL(request.url).pathname;
    requests.push({
      method: request.method,
      path,
      token,
      storeId: request.headers.get('x-store-id'),
      body: text ? JSON.parse(text) : undefined,
    });
    const person = token ? people[token] : undefined;
    if (!person)
      return Response.json(
        { error: 'unauthorized', code: 'unauthorized' },
        { status: 401 },
      );
    if (path === '/v1/me' && request.method === 'GET')
      return person.me instanceof Response
        ? person.me.clone()
        : Response.json(person.me);
    if (path === '/v1/me/pin/verify' && request.method === 'POST') {
      const { pin } = JSON.parse(text) as { pin: string };
      if (person.verify) return person.verify(pin);
      return pin === person.pin
        ? new Response(null, { status: 204 })
        : Response.json(
            { error: 'missing or invalid PIN', code: 'invalid_pin' },
            { status: 401 },
          );
    }
    return Response.json(
      { error: 'not found', code: 'not_found' },
      { status: 404 },
    );
  }) as typeof fetch);
  return {
    spy,
    requests,
    verifies: () => requests.filter(({ path }) => path === '/v1/me/pin/verify'),
    mes: () => requests.filter(({ path }) => path === '/v1/me'),
  };
}
