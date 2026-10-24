import { getMockDb } from '@/test/mock/db';
import type { Session } from '@/stores/session';

/** A signed-in Lead of the seeded test store, so screens under test pass the auth guard. */
export function testSession(): Session {
  const { members, currentMemberId, store } = getMockDb();
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    member: members.find((m) => m.id === currentMemberId)!,
    store,
  };
}
