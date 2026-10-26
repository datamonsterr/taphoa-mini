import {
  createApiClient,
  type ApiClient,
  type components,
} from '@taphoa/api-client';
import { expect } from 'vitest';
import { getBackendUrl } from './env.js';

import { randomUUID } from 'node:crypto';
import { createUser, createSession, createSessionToken } from './clerk.js';

export type Member = components['schemas']['Member'];
export type Store = components['schemas']['Store'];
export type Invite = components['schemas']['Invite'];
export type ErrorResponse = components['schemas']['Error'];
export type CreateStoreRequest = components['schemas']['CreateStoreRequest'];
export type BankAccount = components['schemas']['BankAccount'];
export type Role = components['schemas']['Role'];
export type StoreMembership = components['schemas']['StoreMembership'];
export type Me = components['schemas']['Me'];

export function uniqueName(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function uniqueEmail(): string {
  return `e2e-${randomUUID()}+clerk_test@example.com`;
}

export async function createClerkUser(options?: {
  email?: string;
  firstName?: string;
  lastName?: string;
}) {
  const email = options?.email ?? uniqueEmail();
  const user = await createUser({ ...options, email });
  const session = await createSession(user.id);
  const mint = () => createSessionToken(session.id);
  const token = await mint();
  return { userId: user.id, email, sessionId: session.id, token, mint };
}

export type TestUser = Awaited<ReturnType<typeof createClerkUser>>;
export type StoreSession = StoreMembership & {
  access_token: string;
  clerk_user_id: string;
  clerk_session_id: string;
};

export function newClient(token?: string, storeId?: string): ApiClient {
  // Buffer request bodies: streaming races the server's early 401 (EPIPE).
  const bufferedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();
    return fetch(request.url, { method: request.method, headers, body });
  };
  return createApiClient({
    baseUrl: getBackendUrl(),
    fetch: bufferedFetch,
    getToken: token ? () => token : undefined,
    getStoreId: storeId ? () => storeId : undefined,
  });
}

export function authedClient(
  session: { access_token: string; store?: { id: string } } | string,
  storeId?: string,
): ApiClient {
  return typeof session === 'string'
    ? newClient(session, storeId)
    : newClient(session.access_token, storeId ?? session.store?.id);
}

export interface CreatedStore {
  client: ApiClient;
  session: StoreSession;
  storeName: string;
  user: TestUser;
}

function membershipResult(data: StoreMembership, user: TestUser): CreatedStore {
  assertStoreMembership(data);
  const session = {
    ...data,
    access_token: user.token,
    clerk_user_id: user.userId,
    clerk_session_id: user.sessionId,
  };
  return {
    client: authedClient(session),
    session,
    storeName: data.store.name,
    user,
  };
}

export async function createStore(
  overrides?: Partial<CreateStoreRequest>,
): Promise<CreatedStore> {
  const user = await createClerkUser();
  const result = await newClient(user.token).raw.POST('/v1/stores', {
    body: {
      store_name: uniqueName('CuaHang'),
      display_name: uniqueName('Lead'),
      ...overrides,
    },
  });
  if (result.response.status !== 201 || !result.data) {
    throw new Error(`Failed to create store: HTTP ${result.response.status}`);
  }
  return membershipResult(result.data, user);
}

export interface JoinedSeller extends CreatedStore {
  invite: Invite;
}

export async function joinAsSeller(
  leadClient: ApiClient,
  options?: { can_enroll?: boolean; display_name?: string },
): Promise<JoinedSeller> {
  const invite = await leadClient.raw.POST('/v1/invites', {
    body: {
      role: 'seller',
      can_enroll: options?.can_enroll ?? false,
      ttl_seconds: 600,
    },
  });
  if (invite.response.status !== 201 || !invite.data) {
    throw new Error(
      `Failed to create seller invite: HTTP ${invite.response.status}`,
    );
  }
  assertInvite(invite.data);
  const user = await createClerkUser();
  const result = await newClient(user.token).raw.POST('/v1/auth/join', {
    body: {
      invite_token: invite.data.token,
      display_name: options?.display_name ?? uniqueName('Seller'),
    },
  });
  if (result.response.status !== 201 || !result.data) {
    throw new Error(`Failed to join as seller: HTTP ${result.response.status}`);
  }
  return { ...membershipResult(result.data, user), invite: invite.data };
}

export function assertStoreMembership(
  value: unknown,
): asserts value is StoreMembership {
  expect(value).toBeDefined();
  const membership = value as StoreMembership;
  assertMember(membership.member);
  assertStore(membership.store);
}

export function assertMe(value: unknown): asserts value is Me {
  expect(value).toBeDefined();
  const me = value as Me;
  expect(typeof me.clerk_user_id).toBe('string');
  expect(Array.isArray(me.memberships)).toBe(true);
  for (const membership of me.memberships) assertStoreMembership(membership);
  if (me.profile !== null) {
    expect(me.profile).toBeDefined();
    for (const field of ['display_name', 'email'] as const) {
      expect(
        me.profile[field] === null || typeof me.profile[field] === 'string',
      ).toBe(true);
    }
  }
}

export function assertMember(member: unknown): asserts member is Member {
  expect(member).toBeDefined();
  const m = member as Member;
  expect(typeof m.id).toBe('string');
  expect(typeof m.display_name).toBe('string');
  expect(['lead', 'seller']).toContain(m.role);
  expect(typeof m.can_enroll).toBe('boolean');
  expect(typeof m.has_pin).toBe('boolean');
  expect(typeof m.active).toBe('boolean');
  expect(typeof m.created_at).toBe('string');
}

export function assertStore(store: unknown): asserts store is Store {
  expect(store).toBeDefined();
  const s = store as Store;
  expect(typeof s.id).toBe('string');
  expect(typeof s.name).toBe('string');
  expect(s.timezone).toBe('Asia/Ho_Chi_Minh');
  expect(typeof s.margin_threshold_pct).toBe('number');
  expect(typeof s.version).toBe('number');
  expect(s.version).toBeGreaterThanOrEqual(1);
  expect(typeof s.created_at).toBe('string');
}

export function assertInvite(invite: unknown): asserts invite is Invite {
  expect(invite).toBeDefined();
  const i = invite as Invite;
  expect(typeof i.token).toBe('string');
  expect(i.token.length).toBeGreaterThan(0);
  expect(i.join_url).toMatch(/^taphoa:\/\/join\?token=/);
  expect(['lead', 'seller']).toContain(i.role);
  expect(typeof i.can_enroll).toBe('boolean');
  expect(typeof i.expires_at).toBe('string');
}

export function assertErrorResponse(
  error: unknown,
  expectedCode?: string,
): asserts error is ErrorResponse {
  expect(error).toBeDefined();
  const err = error as ErrorResponse;
  expect(typeof err.error).toBe('string');
  expect(err.error.length).toBeGreaterThan(0);
  expect(typeof err.code).toBe('string');
  if (expectedCode) {
    expect(err.code).toBe(expectedCode);
  }
}
