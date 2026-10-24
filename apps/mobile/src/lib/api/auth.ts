import type { components } from '@taphoa/api-client';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { useSessionStore, type Session } from '@/stores/session';

import { getApiClient } from './client';
import { unwrap } from './errors';

type DeviceInfo = components['schemas']['DeviceInfo'];
type AuthSession = components['schemas']['AuthSession'];

/** The device that signs in; shown to the Lead in the session list. */
export function deviceInfo(): DeviceInfo {
  const platform =
    Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
  const name =
    platform === 'web'
      ? 'Trình duyệt'
      : platform === 'ios'
        ? 'iPhone'
        : 'Điện thoại Android';
  const appVersion = Constants.expoConfig?.version;
  return { name, platform, ...(appVersion ? { app_version: appVersion } : {}) };
}

const toSession = (body: AuthSession): Session => ({
  access_token: body.access_token,
  refresh_token: body.refresh_token,
  member: body.member,
  store: body.store,
});

/** F1: creates the store and its Lead, signs this phone in and returns the one-time recovery code. */
export async function createStore(input: {
  store_name: string;
  display_name: string;
}): Promise<{ recovery_code: string }> {
  const body = await unwrap(
    getApiClient().raw.POST('/v1/stores', {
      body: { ...input, device: deviceInfo() },
    }),
  );
  useSessionStore.getState().setSession(toSession(body), body.recovery_code);
  return { recovery_code: body.recovery_code };
}

/** U1: joins a store with a single-use invite token. */
export async function joinStore(input: {
  invite_token: string;
  display_name: string;
}): Promise<void> {
  const body = await unwrap(
    getApiClient().raw.POST('/v1/auth/join', {
      body: { ...input, device: deviceInfo() },
    }),
  );
  useSessionStore.getState().setSession(toSession(body));
}

/** Signs the Lead in on this phone; the server rotates the recovery code and returns the new one. */
export async function recoverStore(input: {
  recovery_code: string;
}): Promise<{ recovery_code: string }> {
  const body = await unwrap(
    getApiClient().raw.POST('/v1/auth/recover', {
      body: { ...input, device: deviceInfo() },
    }),
  );
  useSessionStore.getState().setSession(toSession(body), body.recovery_code);
  return { recovery_code: body.recovery_code };
}

/**
 * U3/U4: the acting member on this phone changes. A member with a PIN needs it in `pin`; the
 * server answers 401 for a wrong one and 429 once it is locked. The returned session replaces
 * the stored one, so every following request is made as the new member.
 */
export async function switchMember(input: {
  member_id: string;
  pin?: string;
}): Promise<void> {
  const body = await unwrap(
    getApiClient().raw.POST('/v1/auth/switch', { body: input }),
  );
  useSessionStore.getState().setSession(toSession(body));
}

/** U4: sets the signed-in member's PIN (4-6 digits), or clears it with `null`. */
export async function setPin(pin: string | null): Promise<void> {
  await unwrap(getApiClient().raw.PUT('/v1/me/pin', { body: { pin } }));
}

/**
 * Revokes this session on the server, then forgets it. The local session goes either way: a
 * phone that cannot reach the server (or whose session is already dead) must still sign out.
 */
export async function logout(): Promise<void> {
  try {
    await unwrap(getApiClient().raw.POST('/v1/auth/logout'));
  } catch {
    // Offline, or already revoked: the session is forgotten locally all the same.
  } finally {
    useSessionStore.getState().clear();
  }
}
