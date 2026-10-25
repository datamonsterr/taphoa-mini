import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Invite, Member, Role, StorePatch } from './types';

export type Me = import('@taphoa/api-client').components['schemas']['Me'];
export const getMe = (): Promise<Me> =>
  unwrap(getApiClient().raw.GET('/v1/me'));

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

export const createStore = (
  body: import('@taphoa/api-client').components['schemas']['CreateStoreRequest'],
) => unwrap(getApiClient().raw.POST('/v1/stores', { body }));
export const joinStore = (body: {
  invite_token: string;
  display_name: string;
}) => unwrap(getApiClient().raw.POST('/v1/auth/join', { body }));
export const setPin = async (pin: string | null): Promise<void> => {
  await unwrap(getApiClient().raw.PUT('/v1/me/pin', { body: { pin } }));
};
