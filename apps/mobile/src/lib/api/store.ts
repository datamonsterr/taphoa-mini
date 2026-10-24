import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Invite, Member, Role, Store, StorePatch } from './types';

export const getMe = () =>
  unwrap(getApiClient().raw.GET('/v1/me')) as Promise<{
    member: Member;
    store: Store;
  }>;

export const getStore = () => unwrap(getApiClient().raw.GET('/v1/store'));

export const patchStore = (patch: StorePatch) =>
  unwrap(getApiClient().raw.PATCH('/v1/store', { body: patch }));

export const listMembers = async (): Promise<Member[]> =>
  (await unwrap(getApiClient().raw.GET('/v1/members'))).items;

export const createInvite = (input: {
  role?: Role;
  can_enroll?: boolean;
  ttl_seconds?: number;
}): Promise<Invite> =>
  unwrap(getApiClient().raw.POST('/v1/invites', { body: input }));
