import {
  createApiClient,
  type ApiClient,
  type components,
} from '@taphoa/api-client';
import { expect } from 'vitest';
import { getBackendUrl } from './env.js';

export type AuthSession = components['schemas']['AuthSession'];
export type Member = components['schemas']['Member'];
export type Store = components['schemas']['Store'];
export type Invite = components['schemas']['Invite'];
export type ErrorResponse = components['schemas']['Error'];
export type CreateStoreRequest = components['schemas']['CreateStoreRequest'];
export type DeviceInfo = components['schemas']['DeviceInfo'];
export type BankAccount = components['schemas']['BankAccount'];
export type Role = components['schemas']['Role'];

export const RECOVERY_CODE_REGEX = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/;

/**
 * Generates an idempotent, unique name string to isolate tests.
 */
export function uniqueName(prefix = 'e2e'): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Creates an ApiClient against BACKEND_URL, optionally authenticated with a bearer token.
 */
export function newClient(token?: string): ApiClient {
  return createApiClient({
    baseUrl: getBackendUrl(),
    getToken: token ? () => token : undefined,
  });
}

/**
 * Creates an ApiClient authenticated with an AuthSession.
 */
export function authedClient(
  session: AuthSession | { access_token: string } | string,
): ApiClient {
  const token = typeof session === 'string' ? session : session.access_token;
  return newClient(token);
}

export interface CreatedStore {
  client: ApiClient;
  session: AuthSession;
  recoveryCode: string;
  storeName: string;
}

/**
 * Creates a fresh store and Lead member. Each spec must use its own store
 * to remain completely independent and idempotent against a shared database.
 */
export async function createStore(
  overrides?: Partial<CreateStoreRequest>,
): Promise<CreatedStore> {
  const client = newClient();
  const storeName = overrides?.store_name ?? uniqueName('CuaHang');
  const displayName = overrides?.display_name ?? 'Lead ' + uniqueName('lead');
  const device: DeviceInfo = overrides?.device ?? {
    name: 'E2E Runner Device',
    platform: 'android',
    app_version: '1.0.0',
  };

  const body: CreateStoreRequest = {
    store_name: storeName,
    display_name: displayName,
    device,
    ...(overrides?.bank_account
      ? { bank_account: overrides.bank_account }
      : {}),
  };

  const { data, error, response } = await client.raw.POST('/v1/stores', {
    body,
  });

  if (response.status !== 201 || !data) {
    throw new Error(
      `Failed to create store: HTTP ${response.status} ${JSON.stringify(error)}`,
    );
  }

  assertAuthSession(data);
  expect(data.recovery_code).toMatch(RECOVERY_CODE_REGEX);

  return {
    client: authedClient(data),
    session: data,
    recoveryCode: data.recovery_code,
    storeName: data.store.name,
  };
}

export interface JoinedSeller {
  client: ApiClient;
  session: AuthSession;
  invite: Invite;
}

/**
 * Helper to invite and join a seller member using an existing Lead client.
 */
export async function joinAsSeller(
  leadClient: ApiClient,
  options?: { can_enroll?: boolean; display_name?: string },
): Promise<JoinedSeller> {
  const inviteRes = await leadClient.raw.POST('/v1/invites', {
    body: {
      role: 'seller',
      can_enroll: options?.can_enroll ?? false,
      ttl_seconds: 600,
    },
  });

  if (inviteRes.response.status !== 201 || !inviteRes.data) {
    throw new Error(
      `Failed to create seller invite: HTTP ${inviteRes.response.status} ${JSON.stringify(inviteRes.error)}`,
    );
  }

  assertInvite(inviteRes.data);

  const joinClient = newClient();
  const displayName =
    options?.display_name ?? 'Seller ' + uniqueName('banhang');
  const joinRes = await joinClient.raw.POST('/v1/auth/join', {
    body: {
      invite_token: inviteRes.data.token,
      display_name: displayName,
      device: {
        name: 'Seller Phone',
        platform: 'android',
        app_version: '1.0.0',
      },
    },
  });

  if (joinRes.response.status !== 201 || !joinRes.data) {
    throw new Error(
      `Failed to join as seller: HTTP ${joinRes.response.status} ${JSON.stringify(joinRes.error)}`,
    );
  }

  assertAuthSession(joinRes.data);

  return {
    client: authedClient(joinRes.data),
    session: joinRes.data,
    invite: inviteRes.data,
  };
}

export function assertAuthSession(
  session: unknown,
): asserts session is AuthSession {
  expect(session).toBeDefined();
  const s = session as AuthSession;
  expect(typeof s.access_token).toBe('string');
  expect(s.access_token.length).toBeGreaterThan(0);
  expect(typeof s.refresh_token).toBe('string');
  expect(s.refresh_token.length).toBeGreaterThan(0);
  expect(typeof s.expires_in).toBe('number');
  expect(s.expires_in).toBeGreaterThan(0);
  assertMember(s.member);
  assertStore(s.store);
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
