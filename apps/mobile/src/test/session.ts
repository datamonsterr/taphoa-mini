import type { Membership } from '@/stores/currentStore';
import { getMockDb } from '@/test/mock/db';

/** Seed membership; credentials are provided by the reusable Clerk mock. */
export function testSession(): Membership {
  const { members, currentMemberId, store } = getMockDb();
  return { member: members.find((m) => m.id === currentMemberId)!, store };
}
export function setTestMembership(membership: Membership) {
  const db = getMockDb();
  db.store = membership.store;
  db.currentMemberId = membership.member.id;
  db.members = db.members.map((member) =>
    member.id === membership.member.id ? membership.member : member,
  );
}
