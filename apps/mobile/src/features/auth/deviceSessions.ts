import type { useSessionList } from '@clerk/expo';

import { keys } from '@/lib/api/keys';
import type { Me } from '@/lib/api/store';
import { resolveMembership, type Membership } from '@/stores/currentStore';

type LoadedSessionList = Extract<
  ReturnType<typeof useSessionList>,
  { isLoaded: true }
>;
/** A Clerk session registered on this device (`client.sessions`). */
export type DeviceSession = LoadedSessionList['sessions'][number];

/**
 * `client.sessions` also keeps ended and removed sessions, and pending ones that still owe a
 * session task. Only fully signed-in people can be switched to or called with a token.
 */
export const signedInSessions = (
  sessions: readonly DeviceSession[] | undefined,
): DeviceSession[] =>
  (sessions ?? []).filter(({ status }) => status === 'active');

/** React Query key of one session's `/v1/me`. Starts with `api`, so a reset of the cache clears it. */
export const deviceMeKey = (sessionId: string) =>
  [...keys.all, 'device-me', sessionId] as const;

/** The email Clerk knows for this session, when it has one. */
export const sessionEmail = (session: DeviceSession): string | undefined =>
  session.user?.primaryEmailAddress?.emailAddress ||
  session.publicUserData?.identifier ||
  undefined;

/** The person's display name from `/v1/me`, else their email; empty when neither is known. */
export const personName = (session: DeviceSession, me?: Me): string =>
  me?.profile?.display_name?.trim() ||
  sessionEmail(session) ||
  me?.profile?.email ||
  '';

/**
 * The membership whose PIN stands between someone and this phone: the person's selected store
 * (else their first) when it has a PIN, otherwise any other active membership with one. A PIN in
 * any of their stores guards them, so having picked a store without one is no way around it.
 * `/v1/me` lists active memberships only. Null when none has a PIN.
 */
export function pinMembership(
  me: Pick<Me, 'memberships'>,
  selectedStoreId?: string,
): Membership | null {
  const selected = resolveMembership(me.memberships, selectedStoreId);
  if (selected?.member.has_pin) return selected;
  return me.memberships.find(({ member }) => member.has_pin) ?? null;
}
