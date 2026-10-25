import type { useSessionList } from '@clerk/expo';

import { keys } from '@/lib/api/keys';
import type { Me } from '@/lib/api/store';

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
